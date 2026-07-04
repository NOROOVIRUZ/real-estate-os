# Real Estate OS — Worker 백엔드

Cloudflare Worker 단일 배포. **Browser Rendering(네이버 호가) + 국토부 실거래 + KV 저장 + 프론트(docs/) 서빙**.
계약: [`../API.md`](../API.md) · [`../SCHEMA.md`](../SCHEMA.md).

로컬 node 수집기(`collector/collector.js`)를 웹 버튼으로 대체한다. 터미널 없이 `/api/collect` 호출로 수집.

## 구조

```
worker/
  wrangler.jsonc   # 설정 (browser + KV + static assets)
  package.json     # @cloudflare/puppeteer
  src/index.js     # 라우터 + 네이버 수집 + 국토부 + KV
```

- 정적 assets: `../docs` (프론트). `run_worker_first: ["/api/*"]` → `/api/*` 만 Worker, 나머지는 docs/ 정적 서빙.
- KV `REOS_KV`: 키 `watchlist`, `data`.
- Browser Rendering `MYBROWSER`: 네이버 호가 수집(puppeteer).

## 엔드포인트

| 메서드 | 경로 | 동작 |
|--------|------|------|
| GET | `/api/data` | KV `data` (없으면 `{generatedAt:null, complexes:[]}`) |
| GET | `/api/watchlist` | KV `watchlist` (없으면 `{complexes:[]}`) |
| GET | `/api/search?keyword=` | Browser Rendering 으로 네이버 검색 → 후보 단지 목록 전체 `{complexes:[...]}` |
| POST | `/api/watchlist/add` | `{complexNo,name,lawdCd,pinColor?}` 즉시 추가(브라우저 X). 하위호환 `{keyword}` → 검색 첫 결과 추가 |
| POST | `/api/watchlist/remove` | `{complexNo}` → 제거 |
| POST | `/api/watchlist/pin` | `{complexNo, pinColor}` → 핀색 변경 |
| POST | `/api/collect` | watchlist 전체 수집 → KV `data` 저장 |

모든 `/api/*` 는 JSON + CORS(`*`). `/` 등 나머지는 `docs/` 정적 파일.

## 배포

```bash
cd worker
npm install

# KV 네임스페이스 생성 (최초 1회) — 반환된 id 를 wrangler.jsonc 에 반영
npx wrangler kv namespace create REOS_KV

npx wrangler deploy
```

현재 wrangler.jsonc 에 반영된 KV id: `73fc615e4ac240f9beda1d2d37205d44`.

## 국토부 키(MOLIT_API_KEY) 등록 — CF 대시보드 Secret

국토부 실거래 키는 **코드/설정에 절대 하드코딩하지 않는다.** Secret 으로만 주입:

1. Cloudflare 대시보드 → **Workers & Pages** → **real-estate-os**
2. **Settings** → **Variables and Secrets**
3. **Add** → Type: **Secret** → Name `MOLIT_API_KEY` → Value: 국토부(data.go.kr) Encoding 서비스키
4. Save (재배포 불필요, 즉시 반영)

CLI 로도 가능: `npx wrangler secret put MOLIT_API_KEY` (프롬프트에 값 입력).

키가 없으면 `deals` 는 빈 배열로 두고 네이버 호가만 수집한다(크래시 없음).

## Browser Rendering 주의

- 무료 플랜: **하루 10분** 브라우저 사용. `/api/collect`, `/api/watchlist/add` 가 브라우저를 기동한다.
- 단지 수가 많으면 `/api/collect` 1회에 수십 초 소요. 테스트는 하루 2~3회로 제한.
- `browser` 바인딩은 remote 라 **실제 배포로만** 테스트(로컬 dev 불가).

## 프론트 연동

프론트(`docs/`)는 같은 오리진에서 상대경로 `/api/*` 호출. 갱신 버튼 → `POST /api/collect` → 완료 후 `GET /api/data` 리로드.
