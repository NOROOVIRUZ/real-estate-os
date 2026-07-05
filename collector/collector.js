#!/usr/bin/env node
'use strict';

/**
 * Real Estate OS — 수집기
 *
 * watchlist.json (관심 단지) → 네이버부동산 호가 수집 → data.json
 *
 * 사용법:
 *   node collector.js add "<단지명>"   # 검색 → watchlist에 추가
 *   node collector.js remove <complexNo>
 *   node collector.js list
 *   node collector.js                   # watchlist 전체 호가 수집 → data.json
 *
 * 데이터 계약: ../SCHEMA.md 참조. 절대 어기지 말 것.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

// --- 상수 ---------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const WATCHLIST_PATH = path.join(ROOT, 'watchlist.json');
// docs/ 안에 써야 프론트(./data.json)와 GitHub Pages 배포 둘 다 맞물림
const DATA_PATH = path.join(ROOT, 'docs', 'data.json');
// 국토부 키는 이 파일에만. .gitignore 로 git 제외 → 브라우저·git 노출 0.
const ENV_PATH = path.join(__dirname, '.env');

// 국토부 실거래(아파트 매매) API. 서버사이드(node) 호출이라 CORS 무관.
const MOLIT_ENDPOINT =
  'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';
const MOLIT_MONTHS = 6; // 최근 6개월 조회
const MOLIT_DELAY_MS = 400; // 국토부 요청 사이 딜레이 (예의)

// 검증된 Chromium 경로 (playwright-core 1.61.1 / chromium-1217)
const CHROME_PATH = path.join(
  process.env.HOME,
  'Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64',
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);

const NAVER_BASE = 'https://new.land.naver.com';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PER_COMPLEX_DELAY_MS = 1200; // 차단 방지 · 개인용 예의
const HOME_SETTLE_MS = 1800; // 홈 진입 후 /404 리다이렉트 안정화 대기 (실측 필수)

// --- 유틸 ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function loadWatchlist() {
  const wl = readJson(WATCHLIST_PATH, null);
  if (!wl || !Array.isArray(wl.complexes)) return { complexes: [] };
  return wl;
}

/**
 * 네이버 호가 문자열 → 만원 단위 정수
 *   "12억 6,000" → 126000
 *   "9억"        → 90000
 *   "6,000"      → 6000   (억 미만)
 */
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

// --- .env 로딩 (의존성 없이 직접 파싱) ----------------------------------

/**
 * collector/.env 를 fs 로 읽어 KEY=VALUE 파싱. dotenv 등 의존성 추가 없음.
 * 파일이 없거나 키가 없으면 null 반환(크래시 금지 — 국토부만 스킵).
 * 지원: 빈 줄·`#` 주석 무시, 값 양끝 따옴표 제거, KEY=VALUE 의 첫 `=` 기준 분리.
 */
function loadMolitApiKey() {
  let raw;
  try {
    raw = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (_) {
    return null; // .env 없음
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== 'MOLIT_API_KEY') continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    return val || null;
  }
  return null; // 키 라인 없음
}

// --- 국토부 실거래: 단지명 매칭 & 월 목록 -------------------------------

/**
 * 단지명 정규화 — 공백·특수문자 제거(한글/영문/숫자만 남김).
 *   "철산 래미안 자이(1단지)" → "철산래미안자이1단지"
 */
function normalizeName(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[^0-9A-Za-z가-힣]/g, '')
    .toLowerCase();
}

/**
 * 관대한 부분매칭 — 네이버 단지명과 국토부 aptNm 이 정확히 안 맞을 수 있으므로,
 * 정규화 후 한쪽이 다른 쪽을 포함(includes)하면 매칭으로 간주.
 *   "철산래미안자이" vs "철산래미안자이" → true
 *   "래미안자이"     vs "철산래미안자이" → true (aptNm 이 name 을 포함하진 않지만 반대 성립)
 *   "광명푸르지오"   vs "철산래미안자이" → false
 */
function aptNameMatches(aptNm, name) {
  const a = normalizeName(aptNm);
  const b = normalizeName(name);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * 오늘 기준 최근 N개월의 계약년월(YYYYMM) 배열. 최근 → 과거 순.
 *   2026-07 기준, N=6 → ["202607","202606","202605","202604","202603","202602"]
 */
function recentYmds(n) {
  const out = [];
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() + 1; // 1~12
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

// --- 브라우저 세션 ------------------------------------------------------

/**
 * 브라우저를 띄우고 네이버 JWT 토큰을 확보한 뒤,
 * (token, fetchOnNaver) 를 넘겨주는 콜백을 실행한다.
 * fetchOnNaver(relPath) 는 new.land.naver.com 오리진에서 fetch 후 JSON 반환.
 */
async function withNaverSession(fn) {
  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(
      'Chromium 실행 파일을 찾을 수 없습니다:\n  ' +
        CHROME_PATH +
        '\nplaywright-core 1.61.1 (chromium-1217) 설치 상태를 확인하세요.'
    );
  }

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  try {
    const context = await browser.newContext({
      userAgent: DESKTOP_UA,
      locale: 'ko-KR',
      viewport: { width: 1440, height: 900 },
    });

    // 이미지/미디어/폰트만 abort — stylesheet 는 살려 SPA 유지
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();

    // Authorization: Bearer JWT 캡처
    let token = null;
    page.on('request', (req) => {
      const auth = req.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ')) token = auth;
    });

    // 아무 단지 페이지 진입 → 매물 API 호출이 발생하며 토큰이 실린다
    await page.goto(
      NAVER_BASE + '/complexes/120265?&a=APT:ABYG:JGC',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    for (let i = 0; i < 40 && !token; i++) await sleep(200);
    if (!token) throw new Error('네이버 Authorization 토큰을 확보하지 못했습니다.');

    // 토큰 확보 직후 단지 페이지를 떠난다.
    // - 단지 페이지에 머물면 404 리다이렉트로 execution context 가 파괴된다(실측).
    // - about:blank 는 origin 이 "null" 이라 네이버 API 가 CORS 응답을 주지 않아 fetch 가 막힌다(실측).
    // → 홈(new.land.naver.com/) 으로 이동하면 same-origin 이라 CORS 없이 fetch 된다.
    //   단, 홈도 /404 로 리다이렉트하므로 그 안정화를 기다린 뒤 fetch 해야 한다(실측).
    await page.goto(NAVER_BASE + '/', { waitUntil: 'domcontentloaded' });
    await sleep(HOME_SETTLE_MS);

    // 홈 오리진에서 절대경로 fetch (same-origin). SPA 네비게이션으로 context 가 날아가면 홈 재진입 후 재시도.
    async function fetchOnNaver(relPath) {
      const url = NAVER_BASE + relPath;
      const authHeader = token;
      const doFetch = async () => {
        return page.evaluate(
          async ({ u, auth }) => {
            const headers = { accept: 'application/json' };
            if (auth) headers['authorization'] = auth;
            const res = await fetch(u, { headers });
            const text = await res.text();
            return { status: res.status, text };
          },
          { u: url, auth: authHeader }
        );
      };

      let result;
      try {
        result = await doFetch();
      } catch (ctxErr) {
        // execution context 파괴 등 → 홈 재진입 + 안정화 대기 후 1회 재시도
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

// --- 네이버 API 래퍼 ----------------------------------------------------

async function searchComplex({ fetchOnNaver }, keyword) {
  const json = await fetchOnNaver(
    '/api/search?keyword=' + encodeURIComponent(keyword)
  );
  const list = (json && json.complexes) || [];
  return list[0] || null;
}

async function fetchArticles({ fetchOnNaver }, complexNo) {
  const rel =
    '/api/articles/complex/' +
    encodeURIComponent(complexNo) +
    '?realEstateType=APT&tradeType=A1&priceType=RETAIL&page=1' +
    '&complexNo=' +
    encodeURIComponent(complexNo) +
    '&type=list&order=prc';
  const json = await fetchOnNaver(rel);
  return (json && json.articleList) || [];
}

// --- 국토부 실거래 API (node 서버사이드 fetch) --------------------------

/**
 * 국토부 응답의 items.item 을 항상 배열로 정규화.
 * - 0건: items 가 "" 또는 item 없음 → []
 * - 1건: item 이 단일 객체로 옴 → [obj]
 * - N건: item 이 배열 → 그대로
 */
function molitItemsToArray(json) {
  const items =
    json && json.response && json.response.body && json.response.body.items;
  if (!items || typeof items !== 'object') return [];
  const item = items.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

/**
 * 단일 국토부 item → SCHEMA deals 형식.
 *   { date:"YYYY-MM-DD", priceNum: 정수(콤마제거), area: 전용면적 숫자, floor: 정수, buildYear: 정수 }
 */
function molitItemToDeal(it) {
  const priceNum = parseInt(String(it.dealAmount == null ? '' : it.dealAmount).replace(/[^\d]/g, ''), 10);
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

/**
 * 특정 lawdCd·단지명에 대해 최근 6개월 실거래를 조회해 deals 배열 반환.
 * - 단지명 부분매칭되는 aptNm 만 필터
 * - 최근 → 과거 순 정렬
 * - apiKey 없거나 lawdCd 없으면 [] (호출부에서 처리하지만 방어적으로도 처리)
 * - 어떤 월이 에러(인증 실패 시 XML 반환 포함)여도 그 월만 스킵하고 계속 → 크래시 금지
 */
async function fetchMolitDeals(lawdCd, name, apiKey) {
  if (!apiKey || !lawdCd) return [];
  const deals = [];
  const months = recentYmds(MOLIT_MONTHS);

  for (let i = 0; i < months.length; i++) {
    const ymd = months[i];
    // serviceKey(Encoding 키)는 이미 URL 인코딩돼 있으므로 raw 로 붙인다(이중 인코딩 방지).
    // 나머지 파라미터는 순수 숫자/문자.
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
      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        // 인증 실패·서버 오류 시 data.go.kr 은 종종 XML 을 반환한다 → 그 월 스킵
        throw new Error('JSON 아님 (HTTP ' + res.status + ')');
      }
      const items = molitItemsToArray(json);
      for (const it of items) {
        if (!aptNameMatches(it.aptNm, name)) continue;
        deals.push(molitItemToDeal(it));
      }
    } catch (err) {
      console.warn(`      · 국토부 ${ymd} 스킵: ${err.message}`);
    }

    if (i < months.length - 1) await sleep(MOLIT_DELAY_MS);
  }

  // 최근 → 과거 순 (date 문자열 내림차순, null 은 뒤로)
  deals.sort((x, y) => {
    if (!x.date) return 1;
    if (!y.date) return -1;
    return x.date < y.date ? 1 : x.date > y.date ? -1 : 0;
  });
  return deals;
}

// --- 명령: add / remove / list -----------------------------------------

async function cmdAdd(keyword) {
  if (!keyword) {
    console.error('사용법: node collector.js add "<단지명>"');
    process.exit(1);
  }

  const found = await withNaverSession((sess) => searchComplex(sess, keyword));
  if (!found) {
    console.error(`✗ "${keyword}" 검색 결과 없음. watchlist 변경 없음.`);
    process.exit(1);
  }

  const complexNo = String(found.complexNo);
  const cortarNo = String(found.cortarNo || '');
  const lawdCd = cortarNo.slice(0, 5); // 10자리 법정동코드 → 앞 5자리 시군구코드

  const wl = loadWatchlist();
  if (wl.complexes.some((c) => String(c.complexNo) === complexNo)) {
    console.log(
      `= 이미 watchlist 에 있음: ${found.complexName} (${complexNo})`
    );
    return;
  }

  wl.complexes.push({
    complexNo,
    name: found.complexName,
    lawdCd,
    pinColor: 'yellow',
  });
  writeJson(WATCHLIST_PATH, wl);
  console.log(
    `+ 추가: ${found.complexName} (complexNo=${complexNo}, lawdCd=${lawdCd})`
  );
}

function cmdRemove(complexNo) {
  if (!complexNo) {
    console.error('사용법: node collector.js remove <complexNo>');
    process.exit(1);
  }
  const wl = loadWatchlist();
  const before = wl.complexes.length;
  wl.complexes = wl.complexes.filter(
    (c) => String(c.complexNo) !== String(complexNo)
  );
  if (wl.complexes.length === before) {
    console.log(`= watchlist 에 complexNo=${complexNo} 없음. 변경 없음.`);
    return;
  }
  writeJson(WATCHLIST_PATH, wl);
  console.log(`- 제거: complexNo=${complexNo}`);
}

function cmdList() {
  const wl = loadWatchlist();
  if (wl.complexes.length === 0) {
    console.log('watchlist 비어 있음. `node collector.js add "<단지명>"` 로 추가하세요.');
    return;
  }
  console.log(`watchlist (${wl.complexes.length}개):`);
  for (const c of wl.complexes) {
    console.log(
      `  · ${c.name}  complexNo=${c.complexNo}  lawdCd=${c.lawdCd}  pin=${c.pinColor}`
    );
  }
}

// --- 명령: 수집 (기본) --------------------------------------------------

async function cmdCollect() {
  const wl = loadWatchlist();
  if (wl.complexes.length === 0) {
    console.error('watchlist 비어 있음. 먼저 add 하세요.');
    process.exit(1);
  }

  console.log(`수집 시작 — 단지 ${wl.complexes.length}개`);

  // 국토부 키 로드 (없으면 실거래만 스킵, 네이버 호가는 정상 진행)
  const molitKey = loadMolitApiKey();
  if (molitKey) {
    console.log('국토부 실거래: MOLIT_API_KEY 확인됨 — 단지별 최근 6개월 조회');
  } else {
    console.warn(
      '⚠ 국토부 실거래 스킵 — collector/.env 의 MOLIT_API_KEY 없음.\n' +
        '  (.env.example 을 .env 로 복사 후 키 입력. 네이버 호가는 정상 수집합니다. deals 는 빈 배열.)'
    );
  }

  const out = { generatedAt: new Date().toISOString(), complexes: [] };

  await withNaverSession(async (sess) => {
    for (let i = 0; i < wl.complexes.length; i++) {
      const c = wl.complexes[i];
      const prefix = `[${i + 1}/${wl.complexes.length}] ${c.name}`;
      let entry = {
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
        // 메타(주소/좌표/세대수)는 검색 API 로 보강
        const meta = await searchComplex(sess, c.name);
        if (meta && String(meta.complexNo) === String(c.complexNo)) {
          entry.address = meta.cortarAddress || null;
          entry.lat = meta.latitude != null ? Number(meta.latitude) : null;
          entry.lng = meta.longitude != null ? Number(meta.longitude) : null;
          entry.householdCount =
            meta.totalHouseholdCount != null
              ? Number(meta.totalHouseholdCount)
              : null;
          entry.useApproveYmd = meta.useApproveYmd || null;
        }

        const articles = await fetchArticles(sess, c.complexNo);
        // 중개사만 다른 중복 매물(가격+면적+층 동일) 제거
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

        if (entry.listings.length === 0) {
          console.warn(`${prefix} — ⚠ 매물 0건`);
        } else {
          console.log(`${prefix} — ✓ ${entry.listings.length}건`);
        }
      } catch (err) {
        console.warn(`${prefix} — ⚠ 수집 실패: ${err.message} (빈 listings 로 진행)`);
      }

      // 국토부 실거래 — 키·lawdCd 있을 때만. 실패해도 deals 빈 배열로 안전 진행.
      if (molitKey && entry.lawdCd) {
        try {
          entry.deals = await fetchMolitDeals(entry.lawdCd, c.name, molitKey);
          console.log(`${prefix} — 실거래 ${entry.deals.length}건`);
        } catch (err) {
          console.warn(`${prefix} — ⚠ 실거래 조회 실패: ${err.message} (빈 deals 로 진행)`);
          entry.deals = [];
        }
      }

      out.complexes.push(entry);

      if (i < wl.complexes.length - 1) await sleep(PER_COMPLEX_DELAY_MS);
    }
  });

  writeJson(DATA_PATH, out);
  console.log(`완료 — ${DATA_PATH} 생성 (단지 ${out.complexes.length}개)`);
}

// --- 엔트리 -------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case undefined:
        await cmdCollect();
        break;
      case 'add':
        await cmdAdd(rest.join(' ').trim());
        break;
      case 'remove':
        cmdRemove(rest[0]);
        break;
      case 'list':
        cmdList();
        break;
      default:
        console.error(`알 수 없는 명령: ${cmd}`);
        console.error('사용법: node collector.js [add "<단지명>" | remove <complexNo> | list]');
        process.exit(1);
    }
  } catch (err) {
    console.error('오류:', err.message);
    process.exit(1);
  }
}

main();
