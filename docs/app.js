'use strict';

/* ============================================================
   Real Estate OS — 프론트엔드 단일 스크립트
   순수 정적 · localStorage · NAVER Maps (NCP)
   실거래(국토부)는 수집기가 data.json에 미리 넣어줌 → 프론트는 표시만
   ============================================================ */

// ---------- API 베이스 ----------
// 기본: 같은 오리진(Worker가 프론트도 서빙) → 상대경로 '/api/*'
// 로컬 개발: ?api=https://my-worker.dev 로 오버라이드
const API_BASE = (() => {
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q) return q.replace(/\/+$/, ''); // 끝 슬래시 제거
  } catch {}
  return '';
})();
function apiUrl(path) { return API_BASE + path; }

// ---------- localStorage 헬퍼 ----------
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  getNum(k, d = 0) { const v = this.get(k); return v === null || v === '' ? d : Number(v); },
};
const K = {
  naver: 'reos:apikey:naver',
  notes: (no) => `reos:notes:${no}`,
  rating: (no) => `reos:rating:${no}`,
  target: (no) => `reos:target:${no}`,
};

// ---------- 전역 상태 ----------
const state = {
  complexes: [],
  isSample: false,
  dataEmpty: false,   // API가 응답했지만 complexes가 빈 배열 (수집 전)
  busy: false,        // collect/add 진행 중 (중복 클릭 방지)
  selectedNo: null,
  filter: '',
  sort: 'rating_desc',
  compareMode: false,
  compareSel: [],   // complexNo 최대 2개
  searchBusy: false,        // 검색 요청 진행 중
  searchResults: [],        // 마지막 검색 후보 목록 (원본 전체)
  aptOnly: true,            // 검색결과 필터: 아파트(APT)만 (기본 ON)
  watchlistNos: new Set(),  // 이미 watchlist 에 등록된 complexNo (검색결과 '추가됨' 판정용)
  view: 'list',       // 모바일 뷰: 'list' | 'map'
  detailOpen: false,  // 모바일 상세 오버레이 열림 여부
  map: null,
  markers: {},      // complexNo -> naver.maps.Marker
  mapReady: false,
};

// ---------- 유틸 ----------
const $ = (id) => document.getElementById(id);
function ratingOf(no) { return LS.getNum(K.rating(no), 0); }
function fmtEok(manwon) {
  // 만원 단위 정수 -> "12억 6,000" 형태
  if (manwon == null || isNaN(manwon)) return '—';
  const eok = Math.floor(manwon / 10000);
  const rest = manwon % 10000;
  if (eok === 0) return `${rest.toLocaleString()}만`;
  if (rest === 0) return `${eok}억`;
  return `${eok}억 ${rest.toLocaleString()}`;
}
function fmtYmd(ymd) {
  if (!ymd || ymd.length < 6) return '—';
  const y = ymd.slice(0, 4), m = ymd.slice(4, 6), d = ymd.slice(6, 8);
  return d ? `${y}.${m}.${d}` : `${y}.${m}`;
}
function fmtDealDate(date) {
  // deals의 "YYYY-MM-DD" -> "YYYY.MM.DD"
  if (!date) return '—';
  return String(date).replace(/-/g, '.');
}
function normName(s) { return (s || '').replace(/\s+/g, '').toLowerCase(); }

// ---------- 모바일 뷰 전환 / 상세 오버레이 ----------
const mqMobile = window.matchMedia('(max-width: 767px)');
function isMobile() { return mqMobile.matches; }

function updateTabBar(activeKey) {
  document.querySelectorAll('#tabBar .tab-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.view === activeKey);
  });
}

// 탭바로 뷰 전환. 'list' | 'map' | 'compare'
function setView(v) {
  closeDetail(); // 다른 탭으로 이동하면 상세 오버레이 닫기
  if (v === 'compare') {
    // 비교는 목록에서 2개 선택 → 모달. 목록을 띄우고 비교모드 ON.
    document.body.dataset.view = 'list';
    if (!state.compareMode) setCompareMode(true);
    updateTabBar('compare');
    return;
  }
  document.body.dataset.view = v;
  if (state.compareMode) setCompareMode(false);
  updateTabBar(v);
  if (v === 'map' && state.mapReady && state.map) {
    // display:none 이었다가 표시되면 네이버 지도 리사이즈 재계산 필요
    setTimeout(() => {
      try { naver.maps.Event.trigger(state.map, 'resize'); renderMarkers(); } catch {}
    }, 60);
  }
}

function openDetail() {
  state.detailOpen = true;
  if (isMobile()) document.body.classList.add('detail-open');
}
function closeDetail() {
  state.detailOpen = false;
  document.body.classList.remove('detail-open');
}

// ============================================================
//  데이터 로드
// ============================================================
async function loadData() {
  // 목록의 소스 = watchlist(뭐가 보이나), 각 단지 호가/실거래 = data(내용).
  // 둘을 complexNo 로 병합. → 추가만 하고 아직 수집 안 한 단지도 목록에 바로 보임.
  let wl = null, dataArr = null;
  try {
    const res = await fetch(apiUrl('/api/watchlist'), { cache: 'no-store' });
    if (res.ok) { const j = await res.json(); if (j && Array.isArray(j.complexes)) wl = j.complexes; }
  } catch { /* API 미도달 → 샘플 폴백 */ }
  try {
    const res = await fetch(apiUrl('/api/data'), { cache: 'no-store' });
    if (res.ok) { const j = await res.json(); if (j && Array.isArray(j.complexes)) dataArr = j.complexes; }
  } catch { /* data 없어도 watchlist 로 목록은 그림 */ }

  if (wl !== null) {
    const dmap = new Map((dataArr || []).map((c) => [String(c.complexNo), c]));
    state.complexes = wl.map((w) => {
      const no = String(w.complexNo);
      const d = dmap.get(no);
      if (d) {
        // 수집됨: data 내용 + watchlist 의 핀색/이름 우선
        return {
          ...d,
          complexNo: no,
          name: w.name || d.name,
          lawdCd: w.lawdCd || d.lawdCd,
          pinColor: w.pinColor || d.pinColor || 'red',
          collected: true,
        };
      }
      // 미수집: watchlist 정보만 (호가/실거래 없음)
      return {
        complexNo: no, name: w.name, lawdCd: w.lawdCd, pinColor: w.pinColor || 'red',
        address: null, lat: null, lng: null, householdCount: null, useApproveYmd: null,
        listings: [], deals: [], collected: false,
      };
    });
    state.watchlistNos = new Set(wl.map((c) => String(c.complexNo)));
    state.isSample = false;
    state.dataEmpty = state.complexes.length === 0;
    return;
  }

  // 샘플 폴백 (API 미배포/오프라인 개발용)
  try {
    const res = await fetch('./data.sample.json', { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      state.complexes = (json.complexes || []).map((c) => ({ ...c, collected: true }));
      state.isSample = true;
      state.dataEmpty = false;
      return;
    }
  } catch { /* nothing */ }

  state.complexes = [];
  state.isSample = false;
  state.dataEmpty = false;
}

// ============================================================
//  좌측 목록
// ============================================================
function filteredComplexes() {
  const f = normName(state.filter);
  let list = state.complexes.filter((c) => {
    if (!f) return true;
    return normName(c.name).includes(f) || normName(c.address).includes(f);
  });
  if (state.sort === 'name_asc') {
    list.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  } else { // rating_desc
    list.sort((a, b) => ratingOf(b.complexNo) - ratingOf(a.complexNo) || a.name.localeCompare(b.name, 'ko'));
  }
  return list;
}

function renderList() {
  const wrap = $('complexList');
  const empty = $('listEmpty');
  const list = filteredComplexes();
  $('listCount').textContent = `${list.length}개 단지`;

  if (state.complexes.length === 0) {
    wrap.innerHTML = '';
    empty.hidden = false;
    if (state.dataEmpty) {
      empty.innerHTML = `<div class="ph-emoji">📭</div>
        <div class="ph-title">아직 수집된 데이터가 없어</div>
        <div class="ph-sub">＋ 단지 추가로 관심 단지를 등록하고<br />🔄 호가 갱신을 누르세요</div>`;
    } else {
      empty.innerHTML = `<div class="ph-emoji">📡</div>
        <div class="ph-title">데이터를 불러오지 못했어</div>
        <div class="ph-sub">＋ 단지 추가로 시작하거나<br />🔄 호가 갱신을 눌러 다시 시도해</div>`;
    }
    return;
  }
  empty.hidden = true;

  wrap.innerHTML = list.map((c) => {
    const r = ratingOf(c.complexNo);
    const active = c.complexNo === state.selectedNo ? ' active' : '';
    const selected = state.compareSel.includes(c.complexNo) ? ' selected' : '';
    const check = selected ? '<span class="item-check">✓</span>' : '';
    const uncollected = c.collected === false;
    const badge = uncollected ? '<span class="item-badge">미수집</span>' : '';
    const sub = uncollected
      ? '<span class="sub-uncollected">아직 수집 안 됨 · 🔄 갱신 필요</span>'
      : escapeHtml(c.address || '');
    return `<div class="complex-item${active}${selected}" data-no="${c.complexNo}">
      <span class="pin-dot pin-${c.pinColor || 'red'}"></span>
      <div class="item-main">
        <div class="item-name">${escapeHtml(c.name)}${badge}</div>
        <div class="item-sub">${sub}</div>
      </div>
      <span class="item-rating">${r ? '★'.repeat(r) : ''}</span>
      ${check}
      <button class="item-remove" data-remove="${escapeHtml(c.complexNo)}" title="관심 단지에서 삭제" aria-label="삭제">✕</button>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.complex-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.item-remove')) return; // 삭제 버튼은 별도 처리
      onItemClick(el.dataset.no);
    });
  });
  wrap.querySelectorAll('.item-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeComplex(btn.dataset.remove);
    });
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function onItemClick(no) {
  if (state.compareMode) {
    toggleCompareSelection(no);
    return;
  }
  selectComplex(no, true);
}

function selectComplex(no, focusMap) {
  state.selectedNo = no;
  renderList();
  renderDetail(no);
  openDetail(); // 모바일: 상세 전체화면 오버레이 슬라이드업
  if (focusMap && state.mapReady) {
    const c = state.complexes.find((x) => x.complexNo === no);
    if (c && c.lat && c.lng) {
      state.map.panTo(new naver.maps.LatLng(c.lat, c.lng));
    }
  }
}

// ============================================================
//  우측 상세
// ============================================================
function renderDetail(no) {
  const c = state.complexes.find((x) => x.complexNo === no);
  const body = $('detailBody');
  const empty = $('detailEmpty');
  if (!c) { body.hidden = true; empty.hidden = false; return; }
  empty.hidden = true; body.hidden = false;
  const topName = $('detailTopName');
  if (topName) topName.textContent = c.name;

  const listings = (c.listings || []).slice().sort((a, b) => (a.priceNum || 0) - (b.priceNum || 0));
  const min = listings.length ? listings[0].priceNum : null;
  const max = listings.length ? listings[listings.length - 1].priceNum : null;
  const target = LS.getNum(K.target(c.complexNo), 0);
  const r = ratingOf(c.complexNo);

  body.innerHTML = `
    <div class="d-header">
      <div class="d-name"><span class="pin-dot pin-${c.pinColor || 'red'}"></span>${escapeHtml(c.name)}</div>
      <div class="d-address">${escapeHtml(c.address || '')}</div>
      <div class="d-meta-row">
        ${c.householdCount ? `<span class="d-chip">${c.householdCount.toLocaleString()}세대</span>` : ''}
        ${c.useApproveYmd ? `<span class="d-chip">준공 ${fmtYmd(c.useApproveYmd)}</span>` : ''}
        ${c.lawdCd ? `<span class="d-chip">코드 ${escapeHtml(c.lawdCd)}</span>` : ''}
      </div>
      <div class="d-controls-row">
        <div class="rating-stars" id="ratingStars">
          ${[1,2,3,4,5].map((i) => `<span class="star${i <= r ? ' on' : ''}" data-v="${i}">★</span>`).join('')}
        </div>
        <div class="pin-picker" id="pinPicker" title="핀 색상">
          ${['red','yellow','green','blue'].map((col) =>
            `<button type="button" class="pin-swatch pin-${col}${(c.pinColor || 'red') === col ? ' on' : ''}" data-pin="${col}" aria-label="${col}"></button>`
          ).join('')}
        </div>
      </div>
    </div>

    <div class="d-section">
      <div class="d-section-title">💰 현재 호가 <span class="muted">${listings.length}건</span></div>
      ${listings.length ? `
        <div class="price-summary">
          <div class="price-box"><div class="label">최저</div><div class="val">${fmtEok(min)}</div></div>
          <div class="price-box hi"><div class="label">최고</div><div class="val">${fmtEok(max)}</div></div>
        </div>
        ${listings.map((l) => {
          const under = target > 0 && l.priceNum <= target;
          return `<div class="listing-row">
            <span class="lr-price${under ? ' under' : ''}">${escapeHtml(l.price || fmtEok(l.priceNum))}</span>
            <span class="lr-info">${escapeHtml(l.floor || '')} · ${escapeHtml(l.area || '')} · ${escapeHtml(l.direction || '')}</span>
            <span class="lr-date">${fmtYmd(l.confirmYmd)}</span>
          </div>`;
        }).join('')}
      ` : (c.collected === false
        ? `<div class="notice warn">아직 수집 안 됨 — 🔄 호가 갱신을 눌러 수집해</div>`
        : `<div class="notice">등록된 호가가 없어</div>`)}
    </div>

    <div class="d-section">
      <div class="d-section-title">🎯 목표 매수가</div>
      <div class="target-row">
        <input class="target-input" id="targetInput" type="number" inputmode="numeric" placeholder="만원 단위" value="${target || ''}" />
        <span class="target-suffix">만원</span>
      </div>
      <div id="targetBadge"></div>
    </div>

    <div class="d-section">
      <div class="d-section-title">📈 실거래가 <span class="muted" id="dealsCount"></span></div>
      <div id="dealsArea"><div class="notice">불러오는 중…</div></div>
      <div id="dealsChart"></div>
    </div>

    <div class="d-section">
      <div class="d-section-title">📝 메모 <span class="saved-flag" id="memoSaved" hidden>저장됨 ✓</span></div>
      <textarea class="memo-area" id="memoArea" placeholder="이 단지에 대한 메모…">${escapeHtml(LS.get(K.notes(c.complexNo), ''))}</textarea>
    </div>
  `;

  // 별점
  body.querySelectorAll('#ratingStars .star').forEach((el) => {
    el.addEventListener('click', () => {
      const v = Number(el.dataset.v);
      const cur = ratingOf(c.complexNo);
      const next = (v === cur) ? 0 : v; // 같은 별 다시 클릭 시 해제
      LS.set(K.rating(c.complexNo), String(next));
      renderDetail(no);
      renderList();
    });
  });

  // 핀 색상
  body.querySelectorAll('#pinPicker .pin-swatch').forEach((el) => {
    el.addEventListener('click', () => setPinColor(c.complexNo, el.dataset.pin));
  });

  // 목표가
  const ti = $('targetInput');
  const updateTargetBadge = () => {
    const t = Number(ti.value) || 0;
    const badge = $('targetBadge');
    if (t > 0 && min != null) {
      if (min <= t) badge.innerHTML = `<div class="target-badge hit">현재 최저 호가 ${fmtEok(min)} — 목표 이하 달성! 🔥</div>`;
      else badge.innerHTML = `<div class="target-badge miss">최저 ${fmtEok(min)} · 목표까지 ${fmtEok(min - t)} 더</div>`;
    } else badge.innerHTML = '';
  };
  ti.addEventListener('input', () => {
    const t = Number(ti.value) || 0;
    LS.set(K.target(c.complexNo), String(t));
    updateTargetBadge();
    // 호가 행의 '목표 이하' 강조색은 다음 단지 재선택 시 반영 (배지는 즉시 갱신)
  });
  updateTargetBadge();

  // 메모 자동저장
  const ma = $('memoArea');
  let memoTimer = null;
  ma.addEventListener('input', () => {
    LS.set(K.notes(c.complexNo), ma.value);
    const flag = $('memoSaved');
    flag.hidden = false;
    clearTimeout(memoTimer);
    memoTimer = setTimeout(() => { flag.hidden = true; }, 1200);
  });

  // 실거래 (data.json의 deals 표시)
  renderDeals(c);
}

// ============================================================
//  실거래 (수집기가 data.json에 넣은 deals 표시 — 국토부 직접조회 없음)
// ============================================================
function renderDeals(c) {
  const area = $('dealsArea');
  const chart = $('dealsChart');
  const countEl = $('dealsCount');

  const deals = Array.isArray(c.deals) ? c.deals : [];

  if (!deals.length) {
    countEl.textContent = '';
    area.innerHTML = `<div class="notice">실거래 데이터 없음 (수집기에서 국토부 키 설정 후 재수집하세요)</div>`;
    chart.innerHTML = '';
    return;
  }

  countEl.textContent = `${deals.length}건`;

  // data.json은 최근→과거 순. 표는 그대로 최신순으로 최대 12건.
  const shown = deals.slice(0, 12);
  area.innerHTML = shown.map((d) => `
    <div class="deal-row">
      <span class="lr-price">${fmtEok(d.priceNum)}</span>
      <span class="lr-info">${d.floor != null ? d.floor + '층' : ''}${d.area != null ? ' · ' + d.area + '㎡' : ''}${d.buildYear != null ? ' · ' + d.buildYear + '년' : ''}</span>
      <span class="lr-date">${fmtDealDate(d.date)}</span>
    </div>`).join('');

  chart.innerHTML = renderChart(deals);
}

// 인라인 SVG 라인+막대 차트 (외부 라이브러리 없음)
// deals는 최근→과거 순으로 들어옴 → 차트는 과거→최근(왼→오른)으로 그림
function renderChart(deals) {
  const pts = deals.slice().reverse().map((d) => d.priceNum).filter((v) => v > 0);
  if (pts.length < 2) return '';
  const W = 340, H = 120, pad = 8, bottom = 18;
  const min = Math.min(...pts), max = Math.max(...pts);
  const range = max - min || 1;
  const n = pts.length;
  const x = (i) => pad + (i * (W - pad * 2)) / (n - 1);
  const y = (v) => pad + (1 - (v - min) / range) * (H - pad - bottom);

  const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const dots = pts.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="#ff003c"/>`).join('');
  const area = `${line} L${x(n - 1).toFixed(1)},${H - bottom} L${x(0).toFixed(1)},${H - bottom} Z`;

  return `<div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="실거래가 추이">
      <path d="${area}" fill="rgba(255,0,60,0.08)"/>
      <path d="${line}" fill="none" stroke="#ff003c" stroke-width="2"/>
      ${dots}
      <text x="${pad}" y="${H - 4}" font-size="10" fill="#8b95a1">${fmtEok(pts[0])}</text>
      <text x="${W - pad}" y="${H - 4}" font-size="10" fill="#8b95a1" text-anchor="end">${fmtEok(pts[n - 1])}</text>
    </svg>
  </div>`;
}

// ============================================================
//  네이버 지도 (NAVER Cloud Platform Maps JS v3)
// ============================================================
function pinHtml(color) {
  const map = { red: '#ff003c', yellow: '#f59f00', green: '#12b886', blue: '#3182f6' };
  const fill = map[color] || map.red;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40" style="display:block">
    <path d="M15 0C6.7 0 0 6.7 0 15c0 10 15 25 15 25s15-15 15-25C30 6.7 23.3 0 15 0z" fill="${fill}"/>
    <circle cx="15" cy="15" r="6" fill="#fff"/></svg>`;
}

function loadNaverSdk() {
  const key = LS.get(K.naver, '');
  const ph = $('mapPlaceholder');
  if (!key) { ph.hidden = false; return; }

  ph.hidden = true;
  // 이미 로드됨 (네이버는 autoload/load() 개념 없음 — window.naver.maps 즉시 사용)
  if (window.naver && window.naver.maps) { initMap(); return; }

  const existing = document.getElementById('naverSdk');
  if (existing) existing.remove();

  const s = document.createElement('script');
  s.id = 'naverSdk';
  s.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(key)}`;
  s.onload = () => {
    if (window.naver && window.naver.maps) {
      initMap();
    } else {
      ph.hidden = false;
    }
  };
  s.onerror = () => {
    ph.hidden = false;
    $('mapPlaceholder').querySelector('.ph-sub').textContent = '네이버 지도 SDK 로드 실패 — 키를 확인해';
  };
  document.head.appendChild(s);
}

function initMap() {
  const el = $('map');
  const center = new naver.maps.LatLng(37.48, 126.84); // 광명/철산 근처
  state.map = new naver.maps.Map(el, { center, zoom: 13 });
  state.mapReady = true;
  renderMarkers();
}

function renderMarkers() {
  if (!state.mapReady) return;
  Object.values(state.markers).forEach((m) => m.setMap(null));
  state.markers = {};

  const bounds = new naver.maps.LatLngBounds();
  let has = false;
  state.complexes.forEach((c) => {
    if (!c.lat || !c.lng) return;
    has = true;
    const pos = new naver.maps.LatLng(c.lat, c.lng);
    const marker = new naver.maps.Marker({
      position: pos,
      map: state.map,
      title: c.name,
      icon: {
        content: pinHtml(c.pinColor),
        anchor: new naver.maps.Point(15, 40),
      },
    });
    naver.maps.Event.addListener(marker, 'click', () => {
      if (state.compareMode) toggleCompareSelection(c.complexNo);
      else selectComplex(c.complexNo, true);
    });
    state.markers[c.complexNo] = marker;
    bounds.extend(pos);
  });
  if (has) state.map.fitBounds(bounds);
}

// ============================================================
//  비교 모드
// ============================================================
function setCompareMode(on) {
  state.compareMode = on;
  state.compareSel = [];
  $('compareToggle').classList.toggle('active', on);
  $('compareHint').hidden = !on;
  renderList();
}

function toggleCompareSelection(no) {
  const i = state.compareSel.indexOf(no);
  if (i >= 0) state.compareSel.splice(i, 1);
  else {
    if (state.compareSel.length >= 2) state.compareSel.shift();
    state.compareSel.push(no);
  }
  renderList();
  if (state.compareSel.length === 2) openCompareModal();
}

function openCompareModal() {
  const [a, b] = state.compareSel.map((no) => state.complexes.find((c) => c.complexNo === no));
  const body = $('compareBody');
  if (!a || !b) { body.innerHTML = '<div class="compare-empty">단지 2개를 선택해</div>'; }
  else {
    const minL = (c) => {
      const arr = (c.listings || []).map((l) => l.priceNum).filter(Boolean);
      return arr.length ? Math.min(...arr) : null;
    };
    const maxL = (c) => {
      const arr = (c.listings || []).map((l) => l.priceNum).filter(Boolean);
      return arr.length ? Math.max(...arr) : null;
    };
    const rows = [
      ['별점', (c) => ratingOf(c.complexNo) ? '★'.repeat(ratingOf(c.complexNo)) : '—'],
      ['주소', (c) => escapeHtml(c.address || '—')],
      ['세대수', (c) => c.householdCount ? c.householdCount.toLocaleString() + '세대' : '—'],
      ['준공', (c) => fmtYmd(c.useApproveYmd)],
      ['최저 호가', (c) => fmtEok(minL(c))],
      ['최고 호가', (c) => fmtEok(maxL(c))],
      ['호가 건수', (c) => (c.listings || []).length + '건'],
      ['역거리', () => '—'],
    ];
    body.innerHTML = `<table class="compare-table">
      <tr><th></th><td class="th-name">${escapeHtml(a.name)}</td><td class="th-name">${escapeHtml(b.name)}</td></tr>
      ${rows.map(([label, fn]) => `<tr><th>${label}</th><td>${fn(a)}</td><td>${fn(b)}</td></tr>`).join('')}
    </table>`;
  }
  $('compareModal').hidden = false;
}

// ============================================================
//  설정 모달
// ============================================================
function openSettings() {
  $('naverKey').value = LS.get(K.naver, '');
  $('settingsSaved').hidden = true;
  $('settingsModal').hidden = false;
}
function saveSettings() {
  const prevNaver = LS.get(K.naver, '');
  const newNaver = $('naverKey').value.trim();
  LS.set(K.naver, newNaver);
  $('settingsSaved').hidden = false;
  setTimeout(() => { $('settingsSaved').hidden = true; }, 1500);

  // 즉시 반영: 네이버 키가 바뀌었으면 지도 재로드
  if (newNaver !== prevNaver) {
    state.mapReady = false;
    state.markers = {};
    loadNaverSdk();
  }
}

// ============================================================
//  토스트
// ============================================================
function toast(msg, type = 'info', ms = 3200) {
  const wrap = $('toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  // 진입 애니메이션
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

// 데이터 다시 불러 화면 전체 갱신
async function reloadAndRender() {
  await loadData();
  $('dataBadge').hidden = !state.isSample;
  renderList();
  renderMarkers();
  if (state.selectedNo && state.complexes.some((c) => c.complexNo === state.selectedNo)) {
    renderDetail(state.selectedNo);
  } else {
    state.selectedNo = null;
    $('detailBody').hidden = true;
    $('detailEmpty').hidden = false;
    closeDetail();
  }
}

// ============================================================
//  API 액션: 호가 갱신 / 단지 추가·삭제 / 핀색
// ============================================================
function setRefreshBusy(busy) {
  state.busy = busy;
  const btn = $('refreshBtn');
  const sp = $('refreshSpinner');
  const label = $('refreshLabel');
  if (!btn) return;
  btn.disabled = busy;
  btn.classList.toggle('busy', busy);
  if (sp) sp.hidden = !busy;
  if (label) label.textContent = busy ? '갱신 중…' : '🔄 호가 갱신';
}

async function doCollect() {
  if (state.busy) return;
  setRefreshBusy(true);
  toast('호가 수집 중… 최대 30초 걸려', 'info', 4000);
  try {
    const res = await fetch(apiUrl('/api/collect'), { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    await reloadAndRender();
    const count = json.count != null ? json.count : state.complexes.length;
    const secs = json.ms != null ? (json.ms / 1000).toFixed(1) : '?';
    toast(`✅ ${count}개 단지 갱신 완료 (${secs}초)`, 'success');
  } catch (err) {
    toast(`❌ 갱신 실패: ${err.message || err}`, 'error', 5000);
  } finally {
    setRefreshBusy(false);
  }
}

// ---------- 검색 오버레이 (네이버식 검색 → 후보 목록 → 골라서 추가) ----------
function openSearchOverlay() {
  const ov = $('searchOverlay');
  if (!ov) return;
  ov.hidden = false;
  // 이전 검색 잔상 초기화
  state.searchResults = [];
  state.aptOnly = true;
  const cb = $('aptOnly'); if (cb) cb.checked = true;
  $('searchResults').innerHTML = '';
  $('searchFilter').hidden = true;
  setSearchStatus('', null);
  // 이미 등록된 단지 목록을 미리 받아 '추가됨' 판정에 사용 (실패해도 검색은 가능)
  refreshWatchlistNos();
  const kw = $('searchKeyword');
  if (kw) { setTimeout(() => kw.focus(), 50); }
}

function closeSearchOverlay() {
  const ov = $('searchOverlay');
  if (ov) ov.hidden = true;
}

// watchlist 를 받아 등록된 complexNo Set 구성 (검색결과에서 '추가됨' 표시용)
async function refreshWatchlistNos() {
  try {
    const res = await fetch(apiUrl('/api/watchlist'), { cache: 'no-store' });
    if (!res.ok) return;
    const json = await res.json().catch(() => ({}));
    const arr = (json && Array.isArray(json.complexes)) ? json.complexes : [];
    state.watchlistNos = new Set(arr.map((c) => String(c.complexNo)));
    if (state.searchResults.length) renderSearchResults(); // 이미 뜬 목록의 버튼 상태 갱신
  } catch { /* 무시 — 없어도 검색 자체는 됨 */ }
}

function setSearchBusy(busy) {
  state.searchBusy = busy;
  const btn = $('searchGo');
  const sp = $('searchSpinner');
  const label = $('searchGoLabel');
  const input = $('searchKeyword');
  if (btn) btn.disabled = busy;
  if (input) input.disabled = busy;
  if (sp) sp.hidden = !busy;
  if (label) label.textContent = busy ? '검색 중…' : '검색';
}

function setSearchStatus(html, kind) {
  const el = $('searchStatus');
  if (!el) return;
  if (!html) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.className = 'search-status' + (kind ? ' is-' + kind : '');
  el.innerHTML = html;
}

async function doSearch() {
  if (state.searchBusy) return;
  const input = $('searchKeyword');
  if (!input) return;
  const keyword = input.value.trim();
  if (!keyword) { input.focus(); return; }

  setSearchBusy(true);
  state.searchResults = [];
  $('searchResults').innerHTML = '';
  setSearchStatus(
    `<span class="spinner"></span> 네이버에서 검색 중… <span class="muted">(몇 초 걸려요)</span>`,
    'loading'
  );

  try {
    const res = await fetch(apiUrl('/api/search?keyword=' + encodeURIComponent(keyword)), { cache: 'no-store' });
    const json = await res.json().catch(() => ({}));

    // 429: 네이버 과다요청 차단 (status 또는 에러 메시지로 감지)
    if (res.status === 429 || /\b429\b|too many|과다|자주/i.test(json.error || '')) {
      setSearchStatus('⏳ 지금 너무 자주 요청했어요. <b>1분 뒤</b> 다시 시도해줘.', 'warn');
      return;
    }
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);

    const list = Array.isArray(json.complexes) ? json.complexes : [];
    state.searchResults = list;

    if (!list.length) {
      $('searchFilter').hidden = true;
      setSearchStatus(
        '검색 결과가 없어. 다른 검색어를 써봐 <span class="muted">(단지명 일부, 역명 등)</span>.',
        'empty'
      );
      return;
    }
    // 결과 있음 → 타입 필터 노출 후 필터 반영 렌더
    $('searchFilter').hidden = false;
    updateSearchView();
  } catch (err) {
    setSearchStatus(`❌ 검색 실패: ${escapeHtml(err.message || String(err))}`, 'warn');
  } finally {
    setSearchBusy(false);
  }
}

// 타입 필터(아파트만/전체) 반영해 상태문구 + 목록을 갱신. renderSearchResults 대체.
function updateSearchView() {
  const wrap = $('searchResults');
  if (!wrap) return;
  const all = state.searchResults;
  if (!all.length) { wrap.innerHTML = ''; return; }

  // 원본 인덱스를 유지한 채 필터 (addFromSearch가 원본 배열 인덱스 참조)
  const visible = all
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !state.aptOnly || String(c.realEstateTypeCode) === 'APT');

  if (!visible.length) {
    // 결과는 있으나 아파트만 필터로 전부 걸러짐
    wrap.innerHTML = '';
    setSearchStatus(
      '이 검색어엔 <b>아파트가 없어</b>. <span class="muted">아파트만 보기를 끄면 빌라·오피스텔 등을 볼 수 있어.</span>',
      'warn'
    );
    return;
  }

  const label = state.aptOnly ? '아파트' : '단지';
  setSearchStatus(`<b>${visible.length}개</b> ${label}를 찾았어. 추가할 단지를 골라.`, 'ok');

  wrap.innerHTML = visible.map(({ c, i }) => {
    const no = String(c.complexNo);
    const added = state.watchlistNos.has(no);
    const isApt = String(c.realEstateTypeCode) === 'APT';
    const typeName = c.realEstateTypeName || (isApt ? '아파트' : '');
    const meta = [];
    if (c.householdCount) meta.push(`${Number(c.householdCount).toLocaleString()}세대`);
    if (c.useApproveYmd) meta.push(`준공 ${fmtYmd(c.useApproveYmd)}`);
    return `<div class="sr-item" data-i="${i}">
      <div class="sr-main">
        <div class="sr-name">
          ${escapeHtml(c.name || '(이름 없음)')}
          ${typeName ? `<span class="sr-type${isApt ? ' apt' : ''}">${escapeHtml(typeName)}</span>` : ''}
        </div>
        <div class="sr-addr">${escapeHtml(c.address || '')}</div>
        ${meta.length ? `<div class="sr-meta">${meta.join(' · ')}</div>` : ''}
      </div>
      <button class="sr-add${added ? ' added' : ''}" data-add="${i}" ${added ? 'disabled' : ''} type="button">
        ${added ? '추가됨 ✓' : '＋ 추가'}
      </button>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.sr-add').forEach((btn) => {
    btn.addEventListener('click', () => addFromSearch(Number(btn.dataset.add), btn));
  });
}
// 하위 호환 별칭 (add 후 버튼상태 갱신 호출부에서 사용)
function renderSearchResults() { updateSearchView(); }

async function addFromSearch(idx, btn) {
  const c = state.searchResults[idx];
  if (!c) return;
  const no = String(c.complexNo);
  if (state.watchlistNos.has(no)) { toast('이미 추가된 단지야', 'info'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '추가 중…'; }
  try {
    const res = await fetch(apiUrl('/api/watchlist/add'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ complexNo: no, name: c.name, lawdCd: c.lawdCd, pinColor: 'yellow' }),
    });
    const json = await res.json().catch(() => ({}));

    // 서버가 '이미 있음' 을 error 로 돌려주는 케이스 처리
    if (json && json.error && /이미|already|exist/i.test(json.error)) {
      state.watchlistNos.add(no);
      renderSearchResults();
      toast(`이미 추가된 단지: ${c.name}`, 'info');
      return;
    }
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);

    const name = (json.added && json.added.name) || c.name;
    state.watchlistNos.add(no);
    renderSearchResults();
    await reloadAndRender();
    toast(`➕ 추가됨: ${name} — 🔄 호가 갱신을 눌러 수집해`, 'success', 4200);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '＋ 추가'; }
    toast(`❌ 추가 실패: ${err.message || err}`, 'error', 5000);
  }
}

async function removeComplex(complexNo) {
  if (!complexNo) return;
  const c = state.complexes.find((x) => x.complexNo === complexNo);
  const name = c ? c.name : complexNo;
  if (!confirm(`관심 단지에서 삭제할까?\n${name}`)) return;
  try {
    const res = await fetch(apiUrl('/api/watchlist/remove'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ complexNo }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
    if (state.selectedNo === complexNo) state.selectedNo = null;
    await reloadAndRender();
    toast(`🗑️ 삭제됨: ${name}`, 'success');
  } catch (err) {
    toast(`❌ 삭제 실패: ${err.message || err}`, 'error', 5000);
  }
}

async function setPinColor(complexNo, pinColor) {
  if (!complexNo || !pinColor) return;
  // 낙관적 반영
  const c = state.complexes.find((x) => x.complexNo === complexNo);
  const prev = c ? c.pinColor : null;
  if (c) c.pinColor = pinColor;
  renderList();
  renderMarkers();
  if (state.selectedNo === complexNo) renderDetail(complexNo);
  try {
    const res = await fetch(apiUrl('/api/watchlist/pin'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ complexNo, pinColor }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  } catch (err) {
    // 실패 시 롤백
    if (c) c.pinColor = prev;
    renderList();
    renderMarkers();
    if (state.selectedNo === complexNo) renderDetail(complexNo);
    toast(`❌ 핀색 변경 실패: ${err.message || err}`, 'error', 4000);
  }
}

// ============================================================
//  이벤트 바인딩 & 부트
// ============================================================
function bindEvents() {
  const si = $('searchInput');
  si.addEventListener('input', () => {
    state.filter = si.value;
    $('clearSearch').hidden = !si.value;
    renderList();
  });
  $('clearSearch').addEventListener('click', () => {
    si.value = ''; state.filter = ''; $('clearSearch').hidden = true; renderList(); si.focus();
  });
  $('sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });

  // 호가 갱신
  $('refreshBtn').addEventListener('click', doCollect);

  // 단지 추가 → 검색 오버레이 (네이버식 검색→후보 선택→추가)
  $('addToggle').addEventListener('click', openSearchOverlay);
  $('searchClose').addEventListener('click', closeSearchOverlay);
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });
  $('aptOnly').addEventListener('change', (e) => { state.aptOnly = e.target.checked; updateSearchView(); });

  $('compareToggle').addEventListener('click', () => setCompareMode(!state.compareMode));
  $('compareClose').addEventListener('click', () => { $('compareModal').hidden = true; });

  // 하단 탭바 (모바일)
  document.querySelectorAll('#tabBar .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
  // 상세 오버레이 뒤로가기 (모바일)
  const backBtn = $('detailBack');
  if (backBtn) backBtn.addEventListener('click', closeDetail);
  // 데스크톱으로 넓어지면 상세 오버레이 클래스 정리
  mqMobile.addEventListener('change', (e) => { if (!e.matches) closeDetail(); });

  $('settingsBtn').addEventListener('click', openSettings);
  $('mapSettingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', () => { $('settingsModal').hidden = true; });
  $('settingsSave').addEventListener('click', saveSettings);

  // 오버레이 클릭으로 닫기
  document.querySelectorAll('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.hidden = true; });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay').forEach((ov) => ov.hidden = true);
  });
}

async function boot() {
  document.body.dataset.view = 'list'; // 모바일 기본 뷰
  bindEvents();
  await loadData();
  $('dataBadge').hidden = !state.isSample;
  renderList();
  loadNaverSdk();
}

document.addEventListener('DOMContentLoaded', boot);
