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

    return await fn({ fetchOnNaver });
  } finally {
    await browser.close();
  }
}

async function searchComplex({ fetchOnNaver }, keyword) {
  const data = await fetchOnNaver('/api/search?keyword=' + encodeURIComponent(keyword));
  const list = (data && data.complexes) || [];
  return list[0] || null;
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

async function handleWatchlistAdd(env, body) {
  const keyword = (body && body.keyword ? String(body.keyword) : '').trim();
  if (!keyword) return json({ error: 'keyword 필요' }, 400);

  const found = await withNaverSession(env, (sess) => searchComplex(sess, keyword));
  if (!found) return json({ error: `"${keyword}" 검색 결과 없음` }, 404);

  const complexNo = String(found.complexNo);
  const cortarNo = String(found.cortarNo || '');
  const lawdCd = cortarNo.slice(0, 5);

  const wl = await getWatchlist(env);
  if (wl.complexes.some((c) => String(c.complexNo) === complexNo)) {
    return json({ error: '이미 watchlist 에 있음', complexNo, name: found.complexName });
  }

  const added = { complexNo, name: found.complexName, lawdCd, pinColor: 'yellow' };
  wl.complexes.push(added);
  await putWatchlist(env, wl);
  return json({ added });
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

  const molitKey = env.MOLIT_API_KEY || null; // secret. 없으면 deals=[]
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
        entry.listings = articles.map((a) => ({
          tradeType: a.tradeTypeName || null,
          price: a.dealOrWarrantPrc || null,
          priceNum: parsePriceNum(a.dealOrWarrantPrc),
          area: [a.area1, a.area2].filter((v) => v != null).join('/'),
          floor: a.floorInfo || null,
          direction: a.direction || null,
          confirmYmd: a.articleConfirmYmd || null,
          articleNo: a.articleNo != null ? String(a.articleNo) : null,
        }));
      } catch (err) {
        console.warn(`[${i + 1}] ${c.name} 호가 수집 실패: ${err.message}`);
      }

      // 국토부 실거래 — 키·lawdCd 있을 때만. 실패해도 deals 빈 배열로 안전 진행.
      if (molitKey && entry.lawdCd) {
        try {
          entry.deals = await fetchMolitDeals(entry.lawdCd, c.name, molitKey);
        } catch (err) {
          console.warn(`[${i + 1}] ${c.name} 실거래 실패: ${err.message}`);
          entry.deals = [];
        }
      }

      out.complexes.push(entry);
      if (i < wl.complexes.length - 1) await sleep(PER_COMPLEX_DELAY_MS);
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
