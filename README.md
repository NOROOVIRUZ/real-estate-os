# Real Estate OS

관심 단지만 관리하는 개인 부동산 대시보드. 부천·시흥·광명·서울(사당 라인)만 대상.
1인 로컬용, 전부 무료. 백엔드 없음.

## 구조
```
real-estate-os/
├── watchlist.json     관심 단지 목록 (수집기 입력)
├── collector/         네이버 호가 수집기 (node + playwright-core, 로컬 실행)
└── docs/              프론트 (GitHub Pages 배포 폴더) — 지도·실거래·메모
    └── data.json      수집 결과: 네이버 호가 (수집기 출력, 프론트가 ./data.json 로 읽음)
```

## 왜 이 구조인가 (전부 무료)
- **호가**: 네이버부동산은 CORS 막힘 + JWT 필요 → 로컬 node 수집기가 담당 (키 불필요)
- **실거래가**: 국토부 API는 CORS 열려 있어 프론트가 브라우저에서 직접 조회 (키 필요)
- **지도**: Kakao Maps JS, 프론트가 직접 (키 필요)
- **키 저장**: config 파일 아님. 프론트 설정 페이지 → localStorage, **기기마다 별도**
- **메모/별점/목표가**: 프론트 localStorage

## 사용법
### 1. 수집기 (관심 단지 등록 + 호가 수집)
```bash
cd collector && npm install
node collector.js add "철산래미안자이"   # 단지 등록
node collector.js                        # 호가 수집 → ../data.json
```
아침에 한 번, 또는 보기 직전에 실행. 10개 단지 약 15초.

### 2. 프론트 보기
```bash
cd docs && python3 -m http.server 8080   # http://localhost:8080
```
또는 GitHub Pages로 배포 (docs/ 폴더).

### 3. 키 발급 (무료, 노루군이 직접)
- 국토부 실거래: https://www.data.go.kr → "아파트 매매 실거래가 상세 자료"
- Kakao 지도: https://developers.kakao.com → JavaScript 키
- 발급 후 프론트 **설정 페이지**에 입력 (기기별 저장)

## 주의
네이버 호가는 비공식 API. **개인 1인용, 요청 간격 유지(단지당 1.2초), 하루 몇 회만.** 대량 수집 금지.
