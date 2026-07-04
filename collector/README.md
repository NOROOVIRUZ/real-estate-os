# Real Estate OS — 수집기 (collector)

네이버부동산 호가를 `watchlist.json` 기준으로 긁어 `data.json` 을 만든다.
로컬 1인용. 백엔드 없음. 프론트(`../docs/`)와의 계약은 `../SCHEMA.md` 참조.

## 설치

```bash
cd collector
npm install
```

`playwright-core@1.61.1` 만 받는다. Chromium 브라우저는 **별도로 받지 않는다** —
이미 이 맥에 설치된 실행 파일을 직접 쓴다:

```
~/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
```

⚠ 이 경로가 없으면 수집이 실패한다. playwright Chromium(빌드 1217)이 위치에 있어야 한다.
경로가 바뀌면 `collector.js` 의 `CHROME_PATH` 상수를 수정할 것.

## 국토부 실거래 키 설정 (선택 — 실거래 `deals` 를 채우려면 필요)

국토부 실거래가는 수집기(node)가 **서버사이드로** 조회한다. 키는 `collector/.env` 에만 두며
`.gitignore` 로 git 에서 제외되므로 **브라우저·git 에 절대 노출되지 않는다.**

```bash
cd collector
cp .env.example .env
open -e .env      # MOLIT_API_KEY 에 실제 키를 입력
```

- 발급처: [data.go.kr](https://www.data.go.kr) → "아파트 매매 실거래가 상세 자료" 검색 → 활용신청 →
  마이페이지의 **일반 인증키(Encoding)** 를 복사해 붙여넣는다.
- `.env` 는 git 에 **올라가지 않는다** (`../.gitignore` 에 `.env`, `collector/.env` 등록됨).
- 키가 없어도 수집은 정상 동작한다 — 국토부 실거래만 스킵되고 각 단지 `deals` 는 빈 배열이 된다.
  네이버 호가(`listings`) 수집은 키 유무와 무관하게 그대로 진행된다.

수집 시 단지별 `lawdCd`(시군구 5자리)로 **최근 6개월** 실거래를 조회하고,
네이버 단지명과 `aptNm` 이 부분매칭(공백·특수문자 제거 후 서로 포함)되는 거래만 `deals` 에 담는다(최근→과거 순).

## 사용법

### 관심 단지 추가 (검색 → watchlist)

```bash
node collector.js add "철산래미안자이"
node collector.js add "광명푸르지오"
```

네이버 검색 첫 결과를 `../watchlist.json` 에 추가한다.
`complexNo` 는 검색으로 자동, `lawdCd` 는 법정동코드 앞 5자리(시군구코드)로 자동 추출,
`pinColor` 는 `yellow` 기본. 이미 있으면 중복 추가하지 않는다.

### 목록 / 제거

```bash
node collector.js list
node collector.js remove 25902
```

### 호가 수집 (기본 명령)

```bash
node collector.js
```

`watchlist.json` 전체를 돌며 매매 호가를 수집해 `../data.json` 을 생성한다.
단지가 검색 안 되거나 매물 0건이어도 크래시하지 않고 해당 단지는 `listings: []` 로 넣고 경고를 출력한다.

npm scripts 도 있다: `npm run collect`, `npm run list`.

## 출력 형식

`data.json` 은 `SCHEMA.md` 의 계약을 그대로 따른다.
- `priceNum`: 만원 단위 정수 (`"12억 6,000"` → `126000`)
- `area`: `공급/전용` (예 `"83/59"`)
- `deals`: 국토부 실거래. **수집기가 채운다** (`collector/.env` 의 `MOLIT_API_KEY` 로 서버사이드 조회).
  키가 없으면 빈 배열. 프론트는 국토부 키를 아예 모른다.

## rate limit (개인용 예의)

단지당 요청 사이에 **1.2초** 딜레이가 걸려 있다. 차단 방지 및 네이버에 대한 예의 목적이므로
줄이지 말 것. 대량/상업적 크롤링 용도가 아니다.
