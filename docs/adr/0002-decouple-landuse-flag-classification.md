# ADR-0002: 결정형 토지규제 flag 분류를 고비용 재분석에서 분리

**Status:** Proposed
**Date:** 2026-06-22
**Deciders:** yoobinkim (repo owner)

## Context
`classifyLandUseFlags`(`pipeline/cost/acquisition.ts`)는 **순수·결정형**(landUseText에
대한 정규식). 그러나 이 로직을 바꾼 뒤 기존 ~1102건 코퍼스에 반영하려면
`npm run analyze -- --all`뿐인데, 이는 `analyzeRights`·`analyzeLocation`(KAKAO/MOLIT
외부 API)·scoring·report build를 **함께** 재실행한다.

관측:
- 작업 셸의 `.env`에 `KAKAO_REST_KEY` 공란 → `--all` 시 POI 결손 상태로 메모리 `loc`
  기반 점수 재계산 → `saveScore`가 전 건 점수를 **무조건 덮어써 열화**.
  upsert(`shared/db.ts`)는 `market_price`(coalesce)·`transit/schools/amenities`(jsonb
  merge)·`land_use_flags`(preserve-on-empty)는 방어하지만 **score는 보존 로직 없음**.
- 기본 analyze는 `where not exists gm_scores`(신규만) → 기존 코퍼스는 `--all` 없이는
  flag 갱신이 **영구 미반영**.
- `land_use_flags`엔 분류기 외 OSM 플래그(`고압 송전탑 인접`·`대로변(소음)`·
  `철도 인접(소음)`)가 섞여 있어, 단순 덮어쓰기는 이들을 유실시킴.

**근본 원인:** "값싸고 결정적인 enrichment(flag)"가 "비싸고 외부의존·손실성 있는
분석(score/POI)"과 **한 실행 단위로 결합**.

## Decision
저장된 landUseText(`gm_listing_docs`, doc_type `site_metrics`)에서
`classifyLandUseFlags`만 재계산해 **`gm_location_analysis.land_use_flags`만** 갱신하는
멱등 경량 경로(`npm run refresh:flags`)를 도입. 비분류기(OSM) 플래그와 병합 보존하고
score/location/market은 불변. "결정형 enrichment"와 "고비용 분석"을 분리.

## Options Considered

### Option A: 전용 flag-only refresh 커맨드 (권장)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low (읽기→classify→UPDATE 한 컬럼) |
| Cost | 외부 API 0, LLM 0, 키 불필요(DATABASE_URL만) |
| Scalability | 수초(전 코퍼스) |
| Risk | 낮음(점수·POI 불변) |

**Pros:** 키 없이 안전; 즉시 전 코퍼스 반영; 결정형이라 멱등; UI가 `land_use_flags`를
직접 읽어(`web/src/App.tsx`) 곧장 노출.
**Cons:** 분류기 라벨 변경 시 구 라벨 제거 로직 필요(라벨 버전 관리); report
텍스트(`pipeline/report/build.ts`)는 별도라 stale 가능.

### Option B: `--all`의 score 재계산을 가드
입력(POI/시세) 결손 시 `saveScore` 스킵하거나 기존 score 보존.
**Pros:** `--all` 자체가 안전해짐.
**Cons:** 여전히 외부 API·시간 소모; flag만 바꿀 때 과한 비용.

### Option C: 스케줄 `--all`을 풀 env로 상시 실행
**Pros:** 코드 변경 최소.
**Cons:** "운 좋게" 적용에 의존 — 설계가 아닌 운; KAKAO 쿼터/차단 시 회귀.

### Option D: 현상 유지(`--all`만) — 기각
키 결손 셸에서 점수 열화, 기본 실행은 코퍼스 미반영.

## Trade-off Analysis
B는 옳은 보강이지만 "flag만 갱신" 비용 문제를 못 푼다. A가 결정형/고비용 분리라는
핵심을 직접 해결하고 키·외부의존 0이라 가장 안전·즉시. **A 채택 + B(score 보존 가드)
병행**으로 `--all` 안전망도 함께 보강하는 것을 권장.

## Consequences
- **쉬워짐:** flag 로직 변경 → `refresh:flags` 한 번으로 안전 반영; CI에서도 키 없이
  검증 가능.
- **어려워짐:** 분류기 라벨 셋(구/신) 관리 — refresh가 "분류기 소유 라벨"만 교체하고
  OSM 플래그는 보존해야 함.
- **재검토 대상:** report 텍스트·legal-risk 파생값의 stale 처리(필요 시 경량 report
  재생성 단계 추가).

## Action Items
1. [ ] `scripts/refresh-landuse-flags.ts` + `package.json` `refresh:flags`(기본 dry-run, `--apply`로 쓰기)
2. [ ] 분류기 소유 라벨 집합을 `FLAG_DEFS`에서 export → refresh가 구 라벨 제거·OSM 플래그 보존을 정확히
3. [ ] `--all` score 보존 가드: location 입력 결손 시 `saveScore` 스킵 또는 기존값 유지(`pipeline/run.ts`)
4. [ ] (선택) flag 변경 시 report 텍스트만 경량 재생성하는 경로

## Related
- ADR-0001 (멀티세션 worktree 격리) — 본 ADR의 refresh 스크립트도 worktree에서 안전 실행 가능.
