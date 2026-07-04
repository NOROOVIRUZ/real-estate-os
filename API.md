# Real Estate OS — Worker API 계약 (백엔드 ↔ 프론트)

Cloudflare Worker 단일 배포. Browser Rendering(네이버 수집) + 국토부 fetch + KV 저장 + 프론트 서빙.

## 저장 (Cloudflare KV, binding `REOS_KV`)
- key `watchlist` → `{ complexes: [{ complexNo, name, lawdCd, pinColor }] }`
- key `data` → `{ generatedAt, complexes: [ ...단지 + listings + deals ] }` (SCHEMA.md data.json 과 동일 형식)

## 시크릿 (CF 대시보드에서 노루군이 웹으로 등록)
- `MOLIT_API_KEY` — 국토부 실거래 키. 브라우저 노출 0.

## 엔드포인트
| 메서드 | 경로 | 동작 | 응답 |
|--------|------|------|------|
| GET | `/` | 프론트 HTML (Worker static assets = docs/) | HTML |
| GET | `/api/data` | KV의 `data` 반환. 없으면 `{generatedAt:null, complexes:[]}` | data 객체 |
| GET | `/api/watchlist` | KV의 `watchlist` 반환 | watchlist 객체 |
| GET | `/api/search?keyword=` | Browser Rendering으로 네이버 검색 → **후보 단지 목록 전체** 반환(첫 결과만 아님). 순수 fetch 불가(네이버가 브라우저 아닌 요청 429 차단, 실측). | `{complexes:[{complexNo,name,lawdCd,address,lat,lng,householdCount,useApproveYmd,realEstateTypeCode,realEstateTypeName}]}` |

**부동산 타입** (`realEstateTypeCode`): `APT`(아파트) `VL`(빌라/연립) `OPST`(오피스텔) `JGC`(재건축) `ABYG`(분양권) 등. 프론트가 "아파트만" 필터에 사용(기본 아파트만 표시, 빌라·오피스텔 제외).
| POST | `/api/watchlist/add` | body `{complexNo, name, lawdCd, pinColor?}` → 검색으로 고른 단지를 watchlist 추가(브라우저 불필요, 검색결과 재사용). 하위호환: `{keyword}`만 오면 기존처럼 검색해서 첫 결과 추가. | `{added: {...}}` 또는 `{error}` |
| POST | `/api/watchlist/remove` | body `{complexNo}` → watchlist 제거 | `{removed: complexNo}` |
| POST | `/api/watchlist/pin` | body `{complexNo, pinColor}` → 핀색 변경 | `{ok:true}` |
| POST | `/api/collect` | watchlist 전체 수집(네이버 호가 + 국토부 실거래 + 역거리) → KV `data` 저장 | `{ok, count, ms, generatedAt}` |
| GET | `/api/photos?complexNo=` | 단지 사진 목록 (R2) | `{photos:[{id, url, uploadedAt}]}` |
| POST | `/api/photos/upload` | body `{complexNo, dataUrl, caption?}` — dataUrl은 base64 JPEG(프론트가 canvas로 ~1600px 압축 후 전송). R2 `photos/<complexNo>/<id>.jpg` 저장 | `{id, url}` |
| POST | `/api/photos/delete` | body `{complexNo, id}` | `{ok:true}` |
| GET | `/api/photo/<complexNo>/<id>` | R2에서 이미지 바이너리 서빙 (Content-Type image/jpeg, 캐시 헤더) | 이미지 |

**역거리** (`station` 필드): collect 시 단지별로 채움. data.json 단지 객체에 `station: {name, distanceM, walkMin} | null`. 출처는 네이버 단지 상세/overview API(브라우저 세션 내 조회— 인증·경로는 실측으로 확정)의 지하철 정보. 없으면 null(프론트는 "—" 표시). walkMin 없으면 distanceM/67(분속 67m) 반올림.

**사진 저장** = Cloudflare R2 (binding `REOS_R2`, 무료 10GB). 사진은 워커 경유로만 접근.

- 모든 `/api/*` 응답은 JSON. CORS 허용(`Access-Control-Allow-Origin: *`)해서 로컬/타 도메인 프론트도 호출 가능하게.
- `/api/collect`는 최대 ~30초 걸릴 수 있음(Browser Rendering). 프론트는 로딩 표시.

## 네이버 수집 로직 (검증됨, Worker에 puppeteer로 포팅)
- `@cloudflare/puppeteer`, `puppeteer.launch(env.MYBROWSER)`
- 단지페이지 goto → `authorization` Bearer JWT 캡처(page.on('request')) → 홈(new.land.naver.com/) 이동 → 1.8초 대기 → same-origin fetch
- 검색: `/api/search?keyword=` (무인증) → complexes[0]
- 매물: `/api/articles/complex/{cno}?realEstateType=APT&tradeType=A1&priceType=RETAIL&page=1&complexNo={cno}&type=list&order=prc` (Authorization 헤더)
- lawdCd = 검색결과 cortarNo 앞 5자리
- 브라우저 1회 기동 → 토큰 1회 확보 → watchlist 여러 단지 재사용(단지당 딜레이)

## 국토부 실거래 (Worker 서버사이드 fetch, env.MOLIT_API_KEY)
- SCHEMA.md "국토부 실거래 API" 섹션과 동일. 최근 6개월, aptNm 부분매칭, dealAmount 콤마제거 → deals.

## 프론트 변경 (docs/)
- 초기: `GET /api/data`. (data.json 정적파일 fetch 제거)
- [🔄 갱신] 버튼: `POST /api/collect` → 완료 후 data 리로드. 로딩 스피너.
- 단지 검색+추가 UI: `POST /api/watchlist/add {keyword}`. (기존 "터미널에서 추가" 안내 대체)
- 단지 삭제/핀색: `/api/watchlist/remove`, `/api/watchlist/pin`
- 메모/별점/목표가/Kakao키: localStorage 유지 (변경 없음)
- API 베이스 URL: 같은 오리진(Worker가 프론트도 서빙)이면 상대경로 `/api/*`. 로컬 개발용으로 `?api=` 오버라이드 허용하면 편함(선택).
