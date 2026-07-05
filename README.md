# gyeongmae-agent — 경매 매물 권리분석·입지분석 에이전트 (개인 투자용)

부동산 경매 매물을 크롤링해 **조건에 맞는 매물을 선별**하고, 법률데이터에 grounding된
Claude 에이전트가 **권리분석(말소기준권리·인수/소멸·임차인 대항력)** 과 **입지분석(시세·안전마진·교통·학군)** 을
수행하여 **웹 대시보드**와 **매일 아침 텔레그램 다이제스트**로 점수화된 매물을 보여준다.

목표는 **발품 절감** — "대시보드를 뒤지는" 일을 "아침에 추천 N건을 읽는" 일로 바꾼다.

> ⚠️ **면책**: 본 도구의 분석은 **참고용 정보**이며 법률자문이 아니다. 정확성을 보장하지 않으며 최종 판단·책임은 이용자에게 있다.
> 입찰 전 반드시 등기부등본·매각물건명세서·현장 확인 및 변호사/법무사 상담을 권장한다. 개인 이용 전용.

## 발품 절감 기능

| 기능 | 설명 |
|---|---|
| **경쟁 신호** | 법원경매 **관심물건 등록수**를 점수에 반영 — *남들이 덜 본 저경쟁·고마진 딜*을 위로 올림(🔥저경쟁, 정렬 "저경쟁순") |
| **사건 그룹핑** | 한 사건의 여러 물건을 대표 1건 + "외 N물건"으로 접어 검토 횟수↓(🗂 사건묶기) |
| **특수권리 하드제외** | 유치권·지분·법정지상권 등 위험 레드플래그를 통과에서 자동 제외(기본 ON, 조정 가능) |
| **AI 투자 의견서** | 통과 상위 N건에 권리·입지·수익·리스크 종합 + 보수적 입찰가/임장 포인트(Claude **구독 CLI**, 종량제 회피) |
| **일일 다이제스트** | 매일 06:00 KST 분석 후 통과 상위 N건을 텔레그램으로 발송(점수·진짜마진·위험·🔥저경쟁·원본링크) |

## 구조

```
crawler/         법원경매(courtauction.go.kr, 메인)·더낙찰옥션(보조) 크롤러
  adapters/      사이트별 어댑터 (courtauction는 WebSquare dma_ API + 매각물건명세서 파싱)
  normalize.ts   한국어 금액/날짜/물건종류/권리종류 파싱 (순수함수, 테스트됨)
pipeline/
  rights/        권리분석 결정형 rule engine + 소액임차인 표 + Claude 2차 검증(CLI)
  location/      입지분석: 카카오 지오코딩·국토부 실거래가·POI·취득비용
  select/        진짜안전마진 + 인수0 + 경쟁도 점수화/선별
  report/        종합 보고서 + LLM 투자 의견서(memo.ts) + 발품 체크리스트
  legal/         법제처 법령 RAG 인제스트 + 하이브리드 검색
  run.ts         분석 오케스트레이터(점수 패스 → 의견서 2차 패스)
  eval/          모의경매 정답↔엔진 채점(평가셋) + 사례 라이브러리
shared/          공용 도메인 타입 + DB 접근 (node-postgres)
db/              자체호스팅 PostgreSQL 스키마 (db/schema.sql)
server/          Spring Boot 백엔드 (REST API + JdbcTemplate + @Scheduled + 작업 트리거)
web/             대시보드 (Vite + React 19 + TS) — Spring API 소비
scripts/         daily-digest(텔레그램 포맷)·crawl-health·tunnel-health·demo
deploy/          daily-parse.sh (systemd 타이머가 매일 실행)
docs/crawl-proxy.md  집-IP SOCKS 프록시(터널) 무인 운영 구성
```

## 아키텍처 (자체호스팅 on Oracle Cloud VM)

```
[크롤러/분석 (TS, tsx)] --writes--> [PostgreSQL+pgvector] <--reads-- [Spring Boot :8080] <-- [대시보드(React, vite preview :5174)]
        ▲ npm run crawl / analyze / digest                           ▲ @Scheduled · POST /api/jobs/* (대시보드 버튼)
systemd: gyeongmae-api.service(:8080) · gyeongmae-web.service(:5174) · gyeongmae-parse.timer(06:00 KST → deploy/daily-parse.sh)
```

Spring Boot가 API·작업 트리거를 담당하고, 검증된 TS 크롤러/권리분석 엔진을 그대로 재사용(같은 Postgres에 적재). Supabase·Vercel 의존 제거.

## 무인 운영

- **일일 배치**: `gyeongmae-parse.timer`(매일 06:00 KST) → `deploy/daily-parse.sh`:
  `법원경매 크롤(--source=courtauction, 메인) → analyze --all(권리·입지·점수 + LLM 의견서 2차 패스) → 수집 헬스체크 → 다이제스트 → 텔레그램 발송`.
  크롤이 실패해도(차단 등) 분석은 DB·캐시 기반으로 계속 진행.
- **크롤 IP**: VM(데이터센터) IP는 차단되므로 **집 IP SOCKS 프록시**(`CRAWL_PROXY`, `ssh -R` 역터널) 경유. 구성·예방은 `docs/crawl-proxy.md`.
  - ⚠️ 더낙찰옥션 차단은 **계정 단위**(데이터센터 IP 로그인이 트리거) — 법원경매를 메인으로 운용.
- **LLM 비용**: 의견서·2차 검증은 **Claude Max 구독 CLI**(`claude -p`) 사용 → 종량제 API 회피.
  배치 버스트 레이트리밋 대비 throttle + 백오프 재시도 + 입력 해시 캐시 적용(`MEMO`, `MEMO_TOP_N`, `MEMO_THROTTLE_MS`).
- **알림**: 수집 굶음(0건)·크롤 차단·터널 다운·일일 추천을 텔레그램으로 — **경매 전용 봇** `scripts/notify-telegram.sh`
  (`GM_TELEGRAM_BOT_TOKEN`·`GM_TELEGRAM_CHAT_ID`, 미설정 시 기존 `.hermes` 봇 폴백).

## 빠른 시작

```bash
# 1) 의존성 (이미 설치됨)
npm install && (cd web && npm install)

# 2) PostgreSQL + pgvector (이미 이 VM에 설치·DB생성 완료)
#    재설정이 필요하면: psql -d gyeongmae -f db/schema.sql

# 3) 환경변수
cp .env.example .env            # DATABASE_URL · 카카오/국토부/법제처 키 · CRAWL_PROXY(집-IP 터널)
cp web/.env.example web/.env    # (로컬 dev/preview는 /api 를 :8080 으로 프록시)

# 4) 엔진 시연 (키/DB 불필요)
npx tsx scripts/demo.ts

# 5) 테스트 / 타입체크
npm test && npm run typecheck

# 6) Spring 백엔드 (운영은 systemctl, 로컬은 run.sh)
bash server/run.sh                                  # :8080

# 7) 크롤 → 분석
npm run crawl -- --source=courtauction              # 법원경매(메인) 수집 → Postgres
npm run analyze -- --all                            # 권리·입지·점수 + 의견서 → Postgres
MEMO=off npm run analyze                            # 의견서 생략(신규만 빠른 분석)
npm run digest                                      # 다이제스트 텍스트 미리보기(stdout, 발송 X)

# 8) 대시보드
cd web && npm run preview                           # :5174 → Spring API 소비
```

## 데이터 흐름

크롤러(법원경매) → `gm_listings`/`gm_listing_docs` → 분석 파이프라인
(권리 rule engine → 입지 API → 진짜안전마진·경쟁도 점수 → 종합 보고서 → 통과 상위 LLM 의견서)
→ `gm_rights_analysis`/`gm_location_analysis`/`gm_scores` → Spring API → 대시보드/다이제스트.
법령 RAG(`gm_legal_chunks`)는 Claude 검증의 인용 grounding.

## 권리분석 엔진 (핵심)

`pipeline/rights/engine.ts` — 결정형. 우선순위/인수·소멸·대항력 **판정은 코드가** 한다(LLM 아님).
- 말소기준권리 = {근저당·저당·(가)압류·담보가등기·경매개시} 중 최선순위
- 대항력 = `max(점유, 전입)+1일 0시` ≤ 말소기준일 (익일 0시 규칙)
- 소액임차인 = **첫 담보물권 설정일** 기준 시행령 표(`sohaek-table.ts`)
- 인수금액 = 대항력 임차인 미회수 보증금 + 인수 전세권 등
- 유치권·법정지상권·대지권미등기 등 등기부 외 권리는 **레드플래그**(자동판정 X, 사람 검토)
- 법원경매는 **매각물건명세서**의 구조화 필드(임차인·최선순위설정·인수권리)로 분석

## 대시보드 사용법

- **탭**: 🎯 추천(통과 매물·점수순) · 📋 전체 · ★ 관심 · ⚙ 조건.
- **통계 칩**(오늘기일·7일이내·무피후보·검토필요…)은 **클릭하면 필터**로 동작.
- **정렬**: 점수순·**진짜마진순**·**🔥 저경쟁순**·임박순·갭(소자본)순·임장 진행도순.
- **🗂 사건묶기**: 같은 사건 다물건을 1줄로 접음. **🗺 지도**: 마진색 핀.
- **❓ 도움말**: 점수 구성·통과 기준·배지 의미·빠른 사용법 범례. 점수에 마우스를 올리면 분해(안전·권리·경쟁)가 보임.
- **행 클릭 → 상세**: 🧠 AI 투자 의견서 · 권리분석 · 취득비용 · 입찰 전 체크리스트 · 원본 링크.
- **⚙ 조건**: 관심지역·물건종류·가격대·안전마진 기준·경쟁/권리 가중치 조정(localStorage 저장).

## 합법성 메모 (개인 이용)
본인 구독 계정으로 개인 이용 목적만. 폴라이트 크롤(직렬·rate-limit·정직 UA·재배포 금지).
법령/판례 코퍼스(PII 없음)만 RAG. 상용 전환 시 변호사법·PIPA·약관규제법 등 별도 검토 필요.
