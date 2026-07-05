// Real Estate OS — Cloudflare Worker 백엔드
//
//  · Browser Rendering(puppeteer) 로 네이버 호가 수집 (검증된 흐름 재사용)
//  · 국토부 실거래 서버사이드 fetch (env.MOLIT_API_KEY, secret)
//  · KV(REOS_KV) 에 watchlist / data 저장
//  · 프론트(docs/) 는 정적 assets 로 서빙 (/api/* 만 이 Worker 가 처리)
//
// 계약: ../../API.md · ../../SCHEMA.md
// 네이버 수집 로직은 scratchpad/cf-naver-test/src/index.js 에서 실측 검증된 흐름을
// 그대로 신뢰·재사용한다: JWT 캡처 → 홈 same-origin 이동 → 1.8초 대기 → fetch.

import puppeteer from '@cloudflare/puppeteer';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const NAVER_BASE = 'https://new.land.naver.com';
const HOME_SETTLE_MS = 1800; // 홈 진입 후 /404 리다이렉트 안정화 (실측 필수)
const PER_COMPLEX_DELAY_MS = 1200; // 단지 사이 딜레이 (차단 방지 · 예의)

const MOLIT_ENDPOINT =
  'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';
const MOLIT_MONTHS = 6;
const MOLIT_DELAY_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CORS / JSON 응답 ─────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

// ── KV 헬퍼 ──────────────────────────────────────────────────────────────

async function getWatchlist(env) {
  const wl = await env.REOS_KV.get('watchlist', 'json');
  if (!wl || !Array.isArray(wl.complexes)) return { complexes: [] };
  return wl;
}

async function putWatchlist(env, wl) {
  await env.REOS_KV.put('watchlist', JSON.stringify(wl));
}

async function getData(env) {
  const data = await env.REOS_KV.get('data', 'json');
  if (!data || !Array.isArray(data.complexes)) {
    return { generatedAt: null, complexes: [] };
  }
  return data;
}

// ── 가격 파싱 (collector.js 포팅) ─────────────────────────────────────────

// "12억 6,000" → 126000, "9억" → 90000, "6,000" → 6000
function parsePriceNum(price) {
  if (!price || typeof price !== 'string') return null;
  let total = 0;
  const eok = price.match(/(\d+)\s*억/);
  if (eok) total += parseInt(eok[1], 10) * 10000;
  const rest = price.replace(/\d+\s*억/, '');
  const restDigits = rest.replace(/[^\d]/g, '');
  if (restDigits) total += parseInt(restDigits, 10);
  return total > 0 ? total : null;
}

// ── 국토부 단지명 매칭 (collector.js 포팅) ────────────────────────────────

function normalizeName(s) {
  if (s == null) return '';
  return String(s).replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
}

function aptNameMatches(aptNm, name) {
  const a = normalizeName(aptNm);
  const b = normalizeName(name);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

// 최근 N개월 계약년월(YYYYMM), 최근→과거 순
function recentYmds(n) {
  const out = [];
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  for (let i = 0; i < n; i++) {
    out.push(String(y) + String(m).padStart(2, '0'));
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

function molitItemsToArray(json) {
  const items =
    json && json.response && json.response.body && json.response.body.items;
  if (!items || typeof items !== 'object') return [];
  const item = items.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

function molitItemToDeal(it) {
  const priceNum = parseInt(
    String(it.dealAmount == null ? '' : it.dealAmount).replace(/[^\d]/g, ''),
    10
  );
  const y = String(it.dealYear == null ? '' : it.dealYear).trim();
  const mo = String(it.dealMonth == null ? '' : it.dealMonth).trim().padStart(2, '0');
  const d = String(it.dealDay == null ? '' : it.dealDay).trim().padStart(2, '0');
  const area = it.excluUseAr != null ? Number(it.excluUseAr) : null;
  const floor = it.floor != null ? parseInt(String(it.floor).replace(/[^\d-]/g, ''), 10) : null;
  const buildYear = it.buildYear != null ? parseInt(String(it.buildYear).replace(/[^\d]/g, ''), 10) : null;
  return {
    date: y && mo && d ? `${y}-${mo}-${d}` : null,
    priceNum: Number.isFinite(priceNum) ? priceNum : null,
    area: Number.isFinite(area) ? area : null,
    floor: Number.isFinite(floor) ? floor : null,
    buildYear: Number.isFinite(buildYear) ? buildYear : null,
  };
}

// 특정 lawdCd·단지명 최근 6개월 실거래 → deals[]. 월별 에러는 스킵(크래시 금지).
async function fetchMolitDeals(lawdCd, name, apiKey) {
  if (!apiKey || !lawdCd) return [];
  const deals = [];
  const months = recentYmds(MOLIT_MONTHS);

  for (let i = 0; i < months.length; i++) {
    const ymd = months[i];
    // serviceKey(Encoding 키)는 이미 인코딩돼 있으므로 raw 로 붙인다(이중 인코딩 방지).
    const url =
      MOLIT_ENDPOINT +
      '?serviceKey=' + apiKey +
      '&LAWD_CD=' + encodeURIComponent(lawdCd) +
      '&DEAL_YMD=' + encodeURIComponent(ymd) +
      '&_type=json' +
      '&numOfRows=1000';
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        throw new Error('JSON 아님 (HTTP ' + res.status + ')'); // 인증 실패 시 XML → 스킵
      }
      for (const it of molitItemsToArray(data)) {
        if (!aptNameMatches(it.aptNm, name)) continue;
        deals.push(molitItemToDeal(it));
      }
    } catch (err) {
      console.warn(`국토부 ${ymd} 스킵: ${err.message}`);
    }
    if (i < months.length - 1) await sleep(MOLIT_DELAY_MS);
  }

  deals.sort((x, y) => {
    if (!x.date) return 1;
    if (!y.date) return -1;
    return x.date < y.date ? 1 : x.date > y.date ? -1 : 0;
  });
  return deals;
}

// ── 네이버 세션 (검증된 흐름 재사용) ──────────────────────────────────────

// 브라우저 1회 기동 → JWT 1회 확보 → fn({ fetchOnNaver }) 실행.
// fetchOnNaver(relPath) 는 홈(new.land.naver.com/) same-origin 에서 fetch 후 JSON 반환.
async function withNaverSession(env, fn) {
  const browser = await puppeteer.launch(env.MYBROWSER);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);

    let token = null;
    page.on('request', (r) => {
      const a = r.headers()['authorization'];
      if (a && a.startsWith('Bearer') && !token) token = a;
    });

    // 아무 단지 페이지 진입 → 매물 API 호출에 토큰이 실린다
    await page.goto(NAVER_BASE + '/complexes/120265?&a=APT:ABYG:JGC', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    for (let i = 0; i < 40 && !token; i++) await sleep(200);
    if (!token) throw new Error('네이버 Authorization 토큰 확보 실패 (CF IP 차단 가능성)');

    // 단지 페이지에 머물면 404 리다이렉트로 context 파괴, about:blank 는 origin null →
    // 홈으로 이동해야 same-origin fetch 가능. 홈도 /404 리다이렉트하므로 안정화 대기.
    await page.goto(NAVER_BASE + '/', { waitUntil: 'domcontentloaded' });
    await sleep(HOME_SETTLE_MS);

    async function fetchOnNaver(relPath) {
      const doFetch = () =>
        page.evaluate(
          async ({ u, auth }) => {
            const headers = { accept: 'application/json' };
            if (auth) headers['authorization'] = auth;
            const res = await fetch(u, { headers });
            const text = await res.text();
            return { status: res.status, text };
          },
          { u: relPath, auth: token }
        );

      let result;
      try {
        result = await doFetch();
      } catch (_) {
        // context 파괴 등 → 홈 재진입 + 안정화 후 1회 재시도
        await page.goto(NAVER_BASE + '/', { waitUntil: 'domcontentloaded' });
        await sleep(HOME_SETTLE_MS);
        result = await doFetch();
      }
      if (result.status < 200 || result.status >= 300) {
        throw new Error('HTTP ' + result.status + ' @ ' + relPath);
      }
      return JSON.parse(result.text);
    }

    return await fn({ fetchOnNaver, page, browser });
  } finally {
    await browser.close();
  }
}

async function searchComplex({ fetchOnNaver }, keyword) {
  const data = await fetchOnNaver('/api/search?keyword=' + encodeURIComponent(keyword));
  const list = (data && data.complexes) || [];
  return list[0] || null;
}

// 네이버 검색 원본 complexes[] → 프론트가 쓰는 필드로 정규화.
function normalizeComplex(c) {
  const cortarNo = String(c.cortarNo || '');
  return {
    complexNo: String(c.complexNo),
    name: c.complexName || null,
    lawdCd: cortarNo.slice(0, 5),
    address: c.cortarAddress || null,
    lat: c.latitude != null ? Number(c.latitude) : null,
    lng: c.longitude != null ? Number(c.longitude) : null,
    householdCount: c.totalHouseholdCount != null ? Number(c.totalHouseholdCount) : null,
    useApproveYmd: c.useApproveYmd || null,
    realEstateTypeCode: c.realEstateTypeCode || null, // APT(아파트) VL(빌라) OPST(오피스텔) JGC(재건축) ABYG(분양권)
    realEstateTypeName: c.realEstateTypeName || null,
  };
}

// 검색 후보 전체 목록(첫 결과로 자르지 않음).
async function searchComplexes({ fetchOnNaver }, keyword) {
  const data = await fetchOnNaver('/api/search?keyword=' + encodeURIComponent(keyword));
  const list = (data && data.complexes) || [];
  return list.map(normalizeComplex);
}

// ── 역거리 (fin.land front-api — 실측 확정) ───────────────────────────────
//
// 실측 결과 (2026-07-04, complexNo 120265):
//  · new.land 의 overview / complexes 상세 / schools 에는 지하철 정보 없음
//  · fin.land `GET /front-api/v1/article/transport?itemType=complex&itemId={cno}`
//    → result.subwayList[]: { stationName, typeList: [{ name(호선),
//      walkingDistance(m), walkingDuration(분) }] }
//  · 쿠키 없이 호출하면 429 봇 차단 → 실제 fin 페이지 1회 방문(워밍업) 후
//    interception 으로 만든 fin origin 빈 페이지에서 same-origin fetch (검증됨)

// transport 응답 → station {name, distanceM, walkMin} | null. 가장 가까운 역 선택.
function parseStation(data) {
  const list =
    data && data.result && Array.isArray(data.result.subwayList)
      ? data.result.subwayList
      : [];
  let best = null;
  for (const st of list) {
    for (const t of st.typeList || []) {
      const d = t.walkingDistance != null ? Number(t.walkingDistance) : null;
      const w = t.walkingDuration != null ? Number(t.walkingDuration) : null;
      if (d == null && w == null) continue;
      if (
        !best ||
        (d != null && (best.distanceM == null || d < best.distanceM))
      ) {
        best = { name: st.stationName || null, distanceM: d, walkMin: w };
      }
    }
  }
  if (!best) return null;
  if (best.walkMin == null && best.distanceM != null) {
    best.walkMin = Math.round(best.distanceM / 67); // 분속 67m
  }
  return best;
}

// 같은 브라우저(쿠키 공유)에서 fin origin 페이지를 하나 열어
// complexNo → station 맵을 만든다. 실패는 null (collect 를 깨지 않음).
async function fetchStations(browser, complexNos) {
  const out = {};
  for (const cno of complexNos) out[cno] = null;
  if (complexNos.length === 0) return out;

  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.url().includes('/__station_probe__')) {
        r.respond({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html><body>ok</body></html>',
        });
      } else {
        r.continue();
      }
    });
    // 쿠키 워밍업 — 페이지 자체는 튕겨도(404 리다이렉트) 무방
    await page
      .goto('https://fin.land.naver.com/complexes/' + complexNos[0], {
        waitUntil: 'networkidle2',
        timeout: 30000,
      })
      .catch(() => {});
    await sleep(1500);
    await page.goto('https://fin.land.naver.com/__station_probe__', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    for (let i = 0; i < complexNos.length; i++) {
      const cno = complexNos[i];
      try {
        const res = await page.evaluate(async (u) => {
          const r = await fetch(u, { headers: { accept: 'application/json' } });
          return { status: r.status, text: await r.text() };
        }, '/front-api/v1/article/transport?itemType=complex&itemId=' + encodeURIComponent(cno));
        if (res.status === 200) {
          out[cno] = parseStation(JSON.parse(res.text));
        } else {
          console.warn(`역거리 ${cno} HTTP ${res.status}: ${String(res.text).slice(0, 120)}`);
        }
      } catch (err) {
        console.warn(`역거리 ${cno} 실패: ${err.message}`);
      }
      if (i < complexNos.length - 1) await sleep(PER_COMPLEX_DELAY_MS);
    }
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

async function fetchArticles({ fetchOnNaver }, complexNo) {
  const rel =
    '/api/articles/complex/' + encodeURIComponent(complexNo) +
    '?realEstateType=APT&tradeType=A1&priceType=RETAIL&page=1' +
    '&complexNo=' + encodeURIComponent(complexNo) +
    '&type=list&order=prc';
  const data = await fetchOnNaver(rel);
  return (data && data.articleList) || [];
}

// ── 엔드포인트 핸들러 ────────────────────────────────────────────────────

// Browser Rendering 으로 네이버 검색 → 후보 단지 목록 전체 반환.
async function handleSearch(env, keyword) {
  const kw = (keyword || '').trim();
  if (!kw) return json({ error: 'keyword 필요' }, 400);
  const complexes = await withNaverSession(env, (sess) => searchComplexes(sess, kw));
  return json({ complexes });
}

// watchlist 에 단지 1건 추가 (중복 complexNo 방지). 성공 시 { added } 반환.
async function addToWatchlist(env, complexNo, name, lawdCd, pinColor) {
  const wl = await getWatchlist(env);
  if (wl.complexes.some((c) => String(c.complexNo) === complexNo)) {
    return json({ error: '이미 watchlist 에 있음', complexNo, name });
  }
  const added = {
    complexNo,
    name,
    lawdCd: lawdCd || '',
    pinColor: pinColor || 'yellow',
  };
  wl.complexes.push(added);
  await putWatchlist(env, wl);
  return json({ added });
}

async function handleWatchlistAdd(env, body) {
  // 신규 경로: 검색 결과를 골라 넘김 → 브라우저 없이 즉시 추가.
  if (body && body.complexNo != null) {
    const complexNo = String(body.complexNo);
    const name = body.name != null ? String(body.name) : complexNo;
    const lawdCd = body.lawdCd != null ? String(body.lawdCd) : '';
    const pinColor = body.pinColor ? String(body.pinColor) : 'yellow';
    return await addToWatchlist(env, complexNo, name, lawdCd, pinColor);
  }

  // 하위호환: keyword 만 오면 검색해서 첫 결과 추가.
  const keyword = (body && body.keyword ? String(body.keyword) : '').trim();
  if (!keyword) return json({ error: 'complexNo 또는 keyword 필요' }, 400);

  const found = await withNaverSession(env, (sess) => searchComplex(sess, keyword));
  if (!found) return json({ error: `"${keyword}" 검색 결과 없음` }, 404);

  const complexNo = String(found.complexNo);
  const lawdCd = String(found.cortarNo || '').slice(0, 5);
  return await addToWatchlist(env, complexNo, found.complexName, lawdCd, 'yellow');
}

async function handleWatchlistRemove(env, body) {
  const complexNo = body && body.complexNo != null ? String(body.complexNo) : '';
  if (!complexNo) return json({ error: 'complexNo 필요' }, 400);
  const wl = await getWatchlist(env);
  const before = wl.complexes.length;
  wl.complexes = wl.complexes.filter((c) => String(c.complexNo) !== complexNo);
  if (wl.complexes.length === before) return json({ error: 'complexNo 없음', complexNo }, 404);
  await putWatchlist(env, wl);
  return json({ removed: complexNo });
}

async function handleWatchlistPin(env, body) {
  const complexNo = body && body.complexNo != null ? String(body.complexNo) : '';
  const pinColor = body && body.pinColor ? String(body.pinColor) : '';
  if (!complexNo || !pinColor) return json({ error: 'complexNo, pinColor 필요' }, 400);
  const wl = await getWatchlist(env);
  const target = wl.complexes.find((c) => String(c.complexNo) === complexNo);
  if (!target) return json({ error: 'complexNo 없음', complexNo }, 404);
  target.pinColor = pinColor;
  await putWatchlist(env, wl);
  return json({ ok: true });
}

async function handleCollect(env) {
  const t0 = Date.now();
  const wl = await getWatchlist(env);
  if (wl.complexes.length === 0) return json({ error: 'watchlist 비어 있음' }, 400);

  // secret. 없으면 deals=[]. 대시보드 등록 시 이름/값에 공백이 딸려 들어간 경우까지 허용.
  // 국토부는 프론트 직접조회로 이동(CF IP 403 차단). molitKey 미사용.
  const out = { generatedAt: new Date().toISOString(), complexes: [] };

  await withNaverSession(env, async (sess) => {
    for (let i = 0; i < wl.complexes.length; i++) {
      const c = wl.complexes[i];
      const entry = {
        complexNo: String(c.complexNo),
        name: c.name,
        address: null,
        lat: null,
        lng: null,
        householdCount: null,
        useApproveYmd: null,
        pinColor: c.pinColor || 'yellow',
        lawdCd: c.lawdCd || null,
        station: null,
        listings: [],
        deals: [],
      };

      try {
        // 메타(주소/좌표/세대수)를 검색 API 로 보강
        const meta = await searchComplex(sess, c.name);
        if (meta && String(meta.complexNo) === String(c.complexNo)) {
          entry.address = meta.cortarAddress || null;
          entry.lat = meta.latitude != null ? Number(meta.latitude) : null;
          entry.lng = meta.longitude != null ? Number(meta.longitude) : null;
          entry.householdCount =
            meta.totalHouseholdCount != null ? Number(meta.totalHouseholdCount) : null;
          entry.useApproveYmd = meta.useApproveYmd || null;
        }

        const articles = await fetchArticles(sess, c.complexNo);
        const dedup = new Set();
        entry.listings = articles
          .map((a) => ({
            tradeType: a.tradeTypeName || null,
            price: a.dealOrWarrantPrc || null,
            priceNum: parsePriceNum(a.dealOrWarrantPrc),
            area: [a.area1, a.area2].filter((v) => v != null).join('/'),
            floor: a.floorInfo || null,
            direction: a.direction || null,
            confirmYmd: a.articleConfirmYmd || null,
            articleNo: a.articleNo != null ? String(a.articleNo) : null,
          }))
          .filter((l) => {
            const k = `${l.priceNum}-${l.area}-${l.floor}`;
            if (dedup.has(k)) return false;
            dedup.add(k);
            return true;
          });
      } catch (err) {
        console.warn(`[${i + 1}] ${c.name} 호가 수집 실패: ${err.message}`);
      }

      // 국토부 실거래는 워커(CF IP)가 data.go.kr 방화벽에 403 차단당함(실측) →
      // 프론트가 사용자 브라우저에서 직접 조회 + localStorage 캐싱. 여기선 안 채움.
      out.complexes.push(entry);
      if (i < wl.complexes.length - 1) await sleep(PER_COMPLEX_DELAY_MS);
    }

    // 역거리 — 같은 브라우저에서 fin origin 으로 일괄 조회. 실패해도 station=null 진행.
    try {
      const stations = await fetchStations(
        sess.browser,
        out.complexes.map((e) => e.complexNo)
      );
      for (const e of out.complexes) e.station = stations[e.complexNo] || null;
    } catch (err) {
      console.warn(`역거리 수집 실패(전체 스킵): ${err.message}`);
    }
  });

  await env.REOS_KV.put('data', JSON.stringify(out));
  return json({
    ok: true,
    count: out.complexes.length,
    ms: Date.now() - t0,
    generatedAt: out.generatedAt,
  });
}

// ── R2 사진 API (binding REOS_R2, 버킷 reos-photos) ──────────────────────

const PHOTO_MAX_BYTES = 8 * 1024 * 1024; // 8MB
const PHOTO_TYPES = { 'image/jpeg': true, 'image/png': true };

// 경로문자(/, ..) 차단 — 영숫자·하이픈만 허용
function sanitizePhotoId(s) {
  return String(s || '').replace(/[^0-9A-Za-z-]/g, '');
}

function sanitizeComplexNo(s) {
  return String(s || '').replace(/[^\d]/g, '');
}

// 사진 저장소 어댑터 — R2 바인딩 있으면 R2, 없으면 KV 폴백.
// ponytail: R2는 계정에서 카드 등록 후 활성화해야 해서, 켜기 전까지 KV(무료 1GB≈압축사진 수천 장)로 동작.
// KV의 list()는 최대 60초 지연(eventual consistency)이라 목록은 인덱스 키(photoidx:<cno>)로 관리.
function photoStore(env) {
  if (env.REOS_R2) {
    return {
      async list(cno) {
        const r = await env.REOS_R2.list({ prefix: 'photos/' + cno + '/' });
        return (r.objects || []).map((o) => ({
          id: o.key.split('/').pop().replace(/\.jpg$/, ''),
          uploadedAt: o.uploaded ? new Date(o.uploaded).toISOString() : null,
        }));
      },
      async put(cno, id, bytes, ct) {
        await env.REOS_R2.put('photos/' + cno + '/' + id + '.jpg', bytes, {
          httpMetadata: { contentType: ct },
        });
      },
      async get(cno, id) {
        const o = await env.REOS_R2.get('photos/' + cno + '/' + id + '.jpg');
        if (!o) return null;
        return { body: o.body, ct: (o.httpMetadata && o.httpMetadata.contentType) || 'image/jpeg' };
      },
      async del(cno, id) {
        await env.REOS_R2.delete('photos/' + cno + '/' + id + '.jpg');
      },
    };
  }
  const idxKey = (cno) => 'photoidx:' + cno;
  const blobKey = (cno, id) => 'photoblob:' + cno + ':' + id;
  const readIdx = async (cno) => (await env.REOS_KV.get(idxKey(cno), 'json')) || [];
  return {
    async list(cno) {
      return readIdx(cno);
    },
    async put(cno, id, bytes, ct) {
      const uploadedAt = new Date().toISOString();
      await env.REOS_KV.put(blobKey(cno, id), bytes.buffer, { metadata: { ct } });
      const idx = await readIdx(cno);
      idx.push({ id, uploadedAt });
      await env.REOS_KV.put(idxKey(cno), JSON.stringify(idx));
    },
    async get(cno, id) {
      const { value, metadata } = await env.REOS_KV.getWithMetadata(blobKey(cno, id), 'arrayBuffer');
      if (!value) return null;
      return { body: value, ct: (metadata && metadata.ct) || 'image/jpeg' };
    },
    async del(cno, id) {
      await env.REOS_KV.delete(blobKey(cno, id));
      const idx = (await readIdx(cno)).filter((p) => p.id !== id);
      await env.REOS_KV.put(idxKey(cno), JSON.stringify(idx));
    },
  };
}

async function handlePhotosList(env, complexNoRaw) {
  const cno = sanitizeComplexNo(complexNoRaw);
  if (!cno) return json({ error: 'complexNo 필요' }, 400);
  const items = await photoStore(env).list(cno);
  const photos = items.map((p) => ({
    id: p.id,
    url: '/api/photo/' + cno + '/' + p.id,
    uploadedAt: p.uploadedAt || null,
  }));
  return json({ photos });
}

async function handlePhotoUpload(env, body) {
  const cno = sanitizeComplexNo(body && body.complexNo);
  const dataUrl = body && typeof body.dataUrl === 'string' ? body.dataUrl : '';
  if (!cno || !dataUrl) return json({ error: 'complexNo, dataUrl 필요' }, 400);

  const m = dataUrl.match(/^data:([a-z/+.-]+);base64,(.+)$/is);
  if (!m) return json({ error: 'dataUrl 형식 아님 (data:<mime>;base64,...)' }, 400);
  const mime = m[1].toLowerCase();
  const b64 = m[2];
  if (!PHOTO_TYPES[mime]) return json({ error: 'image/jpeg 또는 image/png 만 허용' }, 400);
  // 디코드 전에 크기 개산으로 조기 거부 (base64 → bytes ≈ len*3/4)
  if (b64.length * 0.75 > PHOTO_MAX_BYTES) return json({ error: '최대 8MB 초과' }, 413);

  let bytes;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (_) {
    return json({ error: 'base64 디코드 실패' }, 400);
  }
  if (bytes.length === 0) return json({ error: '빈 이미지' }, 400);
  if (bytes.length > PHOTO_MAX_BYTES) return json({ error: '최대 8MB 초과' }, 413);

  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  await photoStore(env).put(cno, id, bytes, mime);
  return json({ id, url: '/api/photo/' + cno + '/' + id });
}

async function handlePhotoDelete(env, body) {
  const cno = sanitizeComplexNo(body && body.complexNo);
  const id = sanitizePhotoId(body && body.id);
  if (!cno || !id) return json({ error: 'complexNo, id 필요' }, 400);
  await photoStore(env).del(cno, id);
  return json({ ok: true });
}

// GET /api/photo/<complexNo>/<id> → 이미지 바이너리
async function handlePhotoGet(env, pathname) {
  const parts = pathname.split('/').filter(Boolean); // [api, photo, cno, id]
  const cno = sanitizeComplexNo(parts[2]);
  const id = sanitizePhotoId(parts[3]);
  if (!cno || !id) return json({ error: 'not found' }, 404);
  const obj = await photoStore(env).get(cno, id);
  if (!obj) return json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': obj.ct,
      'Cache-Control': 'public, max-age=86400',
      ...CORS,
    },
  });
}

// ── 라우터 ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // run_worker_first 로 /api/* 만 여기 도달하지만, 방어적으로 처리.
    try {
      if (pathname === '/api/data' && request.method === 'GET') {
        return json(await getData(env));
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return json(await getWatchlist(env));
      }
      if (pathname === '/api/search' && request.method === 'GET') {
        return await handleSearch(env, url.searchParams.get('keyword') || '');
      }
      if (pathname === '/api/watchlist/add' && request.method === 'POST') {
        return await handleWatchlistAdd(env, await request.json().catch(() => ({})));
      }
      if (pathname === '/api/watchlist/remove' && request.method === 'POST') {
        return await handleWatchlistRemove(env, await request.json().catch(() => ({})));
      }
      if (pathname === '/api/watchlist/pin' && request.method === 'POST') {
        return await handleWatchlistPin(env, await request.json().catch(() => ({})));
      }
      if (pathname === '/api/collect' && request.method === 'POST') {
        return await handleCollect(env);
      }

      // ── 사진 (R2 있으면 R2, 없으면 KV 폴백 — photoStore) ──
      if (pathname === '/api/photos' && request.method === 'GET') {
        return await handlePhotosList(env, url.searchParams.get('complexNo'));
      }
      if (pathname === '/api/photos/upload' && request.method === 'POST') {
        return await handlePhotoUpload(env, await request.json().catch(() => ({})));
      }
      if (pathname === '/api/photos/delete' && request.method === 'POST') {
        return await handlePhotoDelete(env, await request.json().catch(() => ({})));
      }
      if (pathname.startsWith('/api/photo/') && request.method === 'GET') {
        return await handlePhotoGet(env, pathname);
      }

      if (pathname.startsWith('/api/')) {
        return json({ error: 'not found' }, 404);
      }

      // /api/* 가 아닌 요청 → 정적 assets (run_worker_first 로 보통 여기 안 옴)
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err).slice(0, 300) }, 500);
    }
  },
};
