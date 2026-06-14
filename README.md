# gyeongmae-agent — 경매 매물 권리분석·입지분석 에이전트 (개인 투자용)

부동산 경매 매물을 크롤링해 **조건에 맞는 매물을 선별**하고, 법률데이터에 grounding된
Claude 에이전트가 **권리분석(말소기준권리·인수/소멸·임차인 대항력)** 과 **입지분석(시세·안전마진·교통·학군)** 을
수행하여 **웹 대시보드**에서 점수화된 매물을 보여준다.

> ⚠️ **면책**: 본 도구의 분석은 **참고용 정보**이며 법률자문이 아니다. 정확성을 보장하지 않으며 최종 판단·책임은 이용자에게 있다.
> 입찰 전 반드시 등기부등본·매각물건명세서·현장 확인 및 변호사/법무사 상담을 권장한다. 개인 이용 전용.

## 구조

```
crawler/         더낙찰옥션(메인)·법원경매(폴백) 크롤러 (Playwright)
  adapters/      사이트별 어댑터
  normalize.ts   한국어 금액/날짜/물건종류/권리종류 파싱 (순수함수, 테스트됨)
pipeline/
  rights/        권리분석 결정형 rule engine + 소액임차인 표 + Claude 2차 검증
  location/      입지분석: 카카오 지오코딩·국토부 실거래가·POI
  select/        안전마진 + 인수0 점수화/선별
  legal/         법제처 법령 RAG 인제스트 + 하이브리드 검색
  run.ts         분석 오케스트레이터
shared/          공용 도메인 타입 + Supabase 접근
supabase/        스키마 마이그레이션 (gm_* 테이블, pgvector)
web/             대시보드 (Vite + React 19 + TS) — Vercel 배포
scripts/demo.ts  키/DB 없이 엔진 시연(스모크 테스트)
```

## 빠른 시작

```bash
# 1) 의존성 (이미 설치됨)
npm install && (cd web && npm install)

# 2) 환경변수
cp .env.example .env            # ANTHROPIC/SUPABASE/더낙찰옥션/카카오/국토부/법제처 키
cp web/.env.example web/.env    # VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY

# 3) Supabase 스키마 적용 (택1)
#   - supabase/migrations/0001_init.sql 을 Supabase 대시보드 SQL Editor에 붙여넣기, 또는
#   - supabase CLI: supabase db push, 또는
#   - 연결된 Supabase MCP로 적용

# 4) 엔진 시연 (키 불필요)
npx tsx scripts/demo.ts

# 5) 테스트 / 타입체크
npm test && npm run typecheck

# 6) 크롤 → 분석 → 대시보드
CRAWL_HEADLESS=false npm run crawl -- --inspect   # 최초 1회: 로그인 후 검색 HTML 덤프 → SEL.* 셀렉터 작성
npm run crawl                                      # 매물 수집
npm run analyze                                     # 권리/입지/점수
npm run analyze -- --verify                         # + Claude 2차 검증(법령 인용)
cd web && npm run dev                               # 대시보드
```

## 데이터 흐름

크롤러(더낙찰옥션) → `gm_listings`/`gm_listing_docs` → 분석 파이프라인
(권리 rule engine → 입지 API → 점수) → `gm_rights_analysis`/`gm_location_analysis`/`gm_scores`
→ 대시보드(웹)에서 조회. 법령 RAG(`gm_legal_chunks`)는 Claude 검증의 인용 grounding.

## 권리분석 엔진 (핵심)

`pipeline/rights/engine.ts` — 결정형. 우선순위/인수·소멸·대항력 **판정은 코드가** 한다(LLM 아님).
- 말소기준권리 = {근저당·저당·(가)압류·담보가등기·경매개시} 중 최선순위
- 대항력 = `max(점유, 전입)+1일 0시` ≤ 말소기준일 (익일 0시 규칙)
- 소액임차인 = **첫 담보물권 설정일** 기준 시행령 표(`sohaek-table.ts`)
- 인수금액 = 대항력 임차인 미회수 보증금 + 인수 전세권 등
- 유치권·법정지상권·대지권미등기 등 등기부 외 권리는 **레드플래그**(자동판정 X, 사람 검토)

## 합법성 메모 (개인 이용)
본인 구독 계정으로 개인 이용 목적만. 폴라이트 크롤(직렬·rate-limit·정직 UA·IP우회 금지·재배포 금지).
법령/판례 코퍼스(PII 없음)만 RAG. 상용 전환 시 변호사법·PIPA·약관규제법 등 별도 검토 필요.
