# Real Estate OS — 데이터 계약 (수집기 ↔ 프론트 공유)

로컬 1인용 정적 툴. 백엔드 없음. 전부 무료.

## 흐름
```
watchlist.json (관심 단지) → collector.js (node, 로컬) → docs/data.json → docs/ 프론트
                                  ↑ 네이버 호가 + 국토부 실거래 (둘 다 수집기가 긁음)

프론트가 런타임에 직접 처리:
  · Kakao 지도    ← Kakao JS 키 (설정 페이지 localStorage, 기기별). 브라우저 필수 노출 → 도메인 제한으로 잠금.
  · 메모/별점/목표가 ← localStorage
```
**보안 핵심: 국토부 키는 `collector/.env`에만 (git 제외). 브라우저·git 노출 0.**
수집기가 실거래를 미리 긁어 data.json에 넣으므로 프론트는 국토부 키를 아예 모름.
Kakao 키만 브라우저 노출 불가피 → developers.kakao.com 에서 도메인 등록으로 잠금.

## watchlist.json (수집기 입력 — 사용자가 관리)
```json
{
  "complexes": [
    { "complexNo": "25902", "name": "철산래미안자이", "lawdCd": "41210", "pinColor": "red" }
  ]
}
```
- `complexNo`: 네이버 단지번호 (수집기 `add` 명령이 검색으로 자동 채움)
- `lawdCd`: 국토부 시군구코드 5자리 (실거래가 조회용). 없으면 실거래 스킵.
- `pinColor`: red(매우관심) | yellow(관심) | green(투자검토) | blue(방문완료)

## data.json (수집기 출력 — 프론트 입력, 읽기 전용)
```json
{
  "generatedAt": "2026-07-04T01:20:00.000Z",
  "complexes": [
    {
      "complexNo": "25902",
      "name": "철산래미안자이",
      "address": "경기도 광명시 철산동",
      "lat": 37.4772, "lng": 126.8664,
      "householdCount": 921,
      "useApproveYmd": "20200422",
      "pinColor": "red",
      "lawdCd": "41210",
      "listings": [
        { "tradeType": "매매", "price": "12억 6,000", "priceNum": 126000,
          "area": "83/59", "floor": "중/21", "direction": "남동향",
          "confirmYmd": "20260701", "articleNo": "2635391603" }
      ],
      "deals": [
        { "date": "2026-06-15", "priceNum": 88000, "area": 59.9, "floor": 12, "buildYear": 2020 }
      ]
    }
  ]
}
```
- `priceNum`: 만원 단위 정수 (정렬/차트/비교용). "12억 6,000" → 126000
- `listings`: 네이버 호가. 최신 확인일 순.
- `deals`: 국토부 실거래. **수집기가 채움** (최근→과거 순). 국토부 키 없으면 빈 배열.

## localStorage 키 (프론트 전용)
- `reos:apikey:kakao` → string (Kakao 지도 JS 키, 설정 페이지 입력)
- `reos:notes:<complexNo>` → string (메모, 자동저장)
- `reos:rating:<complexNo>` → number (별점 1~5)
- `reos:target:<complexNo>` → number (목표 매수가, 만원 단위)
- 국토부 키는 localStorage 에 **없음** — collector/.env 에만.

## 국토부 실거래 API (수집기 = node 서버사이드 호출, 키 노출 0)
- 키: `collector/.env` 의 `MOLIT_API_KEY` (.gitignore 로 git 제외)
- 엔드포인트: `https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev`
- 파라미터: `serviceKey`(.env 키), `LAWD_CD`(시군구 5자리 = `lawdCd`), `DEAL_YMD`(계약년월 YYYYMM), `_type=json`, `numOfRows=1000`
- 응답: `response.body.items.item[]` → aptNm(단지명), dealAmount("88,000" 만원 콤마), dealYear/dealMonth/dealDay, excluUseAr(전용면적), floor, buildYear
- 수집기가 단지별 lawdCd로 최근 6개월 조회 → `aptNm` 이 네이버 단지명과 부분매칭되는 것만 필터 → deals 로 저장.
- dealAmount "88,000" → priceNum 88000 (콤마 제거 정수).
