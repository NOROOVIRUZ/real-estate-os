'use strict';

/* ============================================================
   Real Estate OS — 프론트엔드 단일 스크립트
   순수 정적 · localStorage · Kakao Maps
   실거래(국토부)는 수집기가 data.json에 미리 넣어줌 → 프론트는 표시만
   ============================================================ */

// ---------- localStorage 헬퍼 ----------
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  getNum(k, d = 0) { const v = this.get(k); return v === null || v === '' ? d : Number(v); },
};
const K = {
  kakao: 'reos:apikey:kakao',
  notes: (no) => `reos:notes:${no}`,
  rating: (no) => `reos:rating:${no}`,
  target: (no) => `reos:target:${no}`,
};

// ---------- 전역 상태 ----------
const state = {
  complexes: [],
  isSample: false,
  selectedNo: null,
  filter: '',
  sort: 'rating_desc',
  compareMode: false,
  compareSel: [],   // complexNo 최대 2개
  map: null,
  markers: {},      // complexNo -> kakao.maps.Marker
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

// ============================================================
//  데이터 로드
// ============================================================
async function loadData() {
  try {
    const res = await fetch('./data.json', { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      if (json && Array.isArray(json.complexes) && json.complexes.length) {
        state.complexes = json.complexes;
        state.isSample = false;
        return;
      }
    }
  } catch { /* fallthrough to sample */ }

  try {
    const res = await fetch('./data.sample.json', { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      state.complexes = json.complexes || [];
      state.isSample = true;
      return;
    }
  } catch { /* nothing */ }

  state.complexes = [];
  state.isSample = false;
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
    empty.innerHTML = `<div class="ph-emoji">📭</div>
      <div class="ph-title">아직 수집된 데이터가 없어</div>
      <div class="ph-sub">터미널에서 수집기를 실행하세요</div>`;
    return;
  }
  empty.hidden = true;

  wrap.innerHTML = list.map((c) => {
    const r = ratingOf(c.complexNo);
    const active = c.complexNo === state.selectedNo ? ' active' : '';
    const selected = state.compareSel.includes(c.complexNo) ? ' selected' : '';
    const check = selected ? '<span class="item-check">✓</span>' : '';
    return `<div class="complex-item${active}${selected}" data-no="${c.complexNo}">
      <span class="pin-dot pin-${c.pinColor || 'red'}"></span>
      <div class="item-main">
        <div class="item-name">${escapeHtml(c.name)}</div>
        <div class="item-sub">${escapeHtml(c.address || '')}</div>
      </div>
      <span class="item-rating">${r ? '★'.repeat(r) : ''}</span>
      ${check}
    </div>`;
  }).join('');

  wrap.querySelectorAll('.complex-item').forEach((el) => {
    el.addEventListener('click', () => onItemClick(el.dataset.no));
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
  if (focusMap && state.mapReady) {
    const c = state.complexes.find((x) => x.complexNo === no);
    if (c && c.lat && c.lng) {
      state.map.panTo(new kakao.maps.LatLng(c.lat, c.lng));
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
      <div class="rating-stars" id="ratingStars">
        ${[1,2,3,4,5].map((i) => `<span class="star${i <= r ? ' on' : ''}" data-v="${i}">★</span>`).join('')}
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
      ` : `<div class="notice">등록된 호가가 없어</div>`}
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
//  Kakao 지도
// ============================================================
function pinImageSrc(color) {
  const map = { red: '#ff003c', yellow: '#f59f00', green: '#12b886', blue: '#3182f6' };
  const fill = map[color] || map.red;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40">
    <path d="M15 0C6.7 0 0 6.7 0 15c0 10 15 25 15 25s15-15 15-25C30 6.7 23.3 0 15 0z" fill="${fill}"/>
    <circle cx="15" cy="15" r="6" fill="#fff"/></svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

function loadKakaoSdk() {
  const key = LS.get(K.kakao, '');
  const ph = $('mapPlaceholder');
  if (!key) { ph.hidden = false; return; }

  ph.hidden = true;
  // 이미 로드됨
  if (window.kakao && window.kakao.maps) { initMap(); return; }

  const existing = document.getElementById('kakaoSdk');
  if (existing) existing.remove();

  const s = document.createElement('script');
  s.id = 'kakaoSdk';
  s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
  s.onload = () => {
    if (window.kakao && window.kakao.maps) {
      kakao.maps.load(() => initMap());
    } else {
      ph.hidden = false;
    }
  };
  s.onerror = () => {
    ph.hidden = false;
    $('mapPlaceholder').querySelector('.ph-sub').textContent = 'Kakao SDK 로드 실패 — 키를 확인해';
  };
  document.head.appendChild(s);
}

function initMap() {
  const el = $('map');
  const center = new kakao.maps.LatLng(37.48, 126.84); // 광명/철산 근처
  state.map = new kakao.maps.Map(el, { center, level: 6 });
  state.mapReady = true;
  renderMarkers();
}

function renderMarkers() {
  if (!state.mapReady) return;
  Object.values(state.markers).forEach((m) => m.setMap(null));
  state.markers = {};

  const bounds = new kakao.maps.LatLngBounds();
  let has = false;
  state.complexes.forEach((c) => {
    if (!c.lat || !c.lng) return;
    has = true;
    const pos = new kakao.maps.LatLng(c.lat, c.lng);
    const img = new kakao.maps.MarkerImage(
      pinImageSrc(c.pinColor),
      new kakao.maps.Size(30, 40),
      { offset: new kakao.maps.Point(15, 40) }
    );
    const marker = new kakao.maps.Marker({ position: pos, image: img, title: c.name });
    marker.setMap(state.map);
    kakao.maps.event.addListener(marker, 'click', () => {
      if (state.compareMode) toggleCompareSelection(c.complexNo);
      else selectComplex(c.complexNo, true);
    });
    state.markers[c.complexNo] = marker;
    bounds.extend(pos);
  });
  if (has) state.map.setBounds(bounds);
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
  $('kakaoKey').value = LS.get(K.kakao, '');
  $('settingsSaved').hidden = true;
  $('settingsModal').hidden = false;
}
function saveSettings() {
  const prevKakao = LS.get(K.kakao, '');
  const newKakao = $('kakaoKey').value.trim();
  LS.set(K.kakao, newKakao);
  $('settingsSaved').hidden = false;
  setTimeout(() => { $('settingsSaved').hidden = true; }, 1500);

  // 즉시 반영: Kakao 키가 바뀌었으면 지도 재로드
  if (newKakao !== prevKakao) {
    state.mapReady = false;
    state.markers = {};
    loadKakaoSdk();
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

  $('compareToggle').addEventListener('click', () => setCompareMode(!state.compareMode));
  $('compareClose').addEventListener('click', () => { $('compareModal').hidden = true; });

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
  bindEvents();
  await loadData();
  $('dataBadge').hidden = !state.isSample;
  renderList();
  loadKakaoSdk();
}

document.addEventListener('DOMContentLoaded', boot);
