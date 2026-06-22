# ADR-0001: 동시 agent 세션의 git worktree 격리

**Status:** Proposed
**Date:** 2026-06-22
**Deciders:** yoobinkim (repo owner)

## Context
auction-agent 단일 클론(`~/projects/gyeongmae-agent`)을 여러 Claude/agent 세션이
**하나의 working tree + 하나의 브랜치(main)** 로 공유한다. 실제 관측된 증상:

- 한 세션의 미커밋 변경(`pipeline/cost/acquisition.ts`)이 동시 세션의 커밋
  `1c89c0b`("초보자 용어 풀이…")에, 테스트가 `2ace1b8`("사이트 접속차단…")에
  **휩쓸려 들어가 provenance가 깨짐**(커밋 메시지와 변경 내용 불일치).
- HEAD가 작업 중 계속 전진(`e6cb2a2 → 0e6b6cf → 59329bc → 2a9353e …`),
  `git diff`가 비어 보이는 등 상태 혼란.
- 만들지 않은 `scripts/dbg*.ts`가 working tree에 나타났다 사라짐.
- 글로벌 `~/.claude/CLAUDE.md`가 이미 경고하는 시나리오(멀티세션 코디네이션).

**근본 원인:** N개 세션이 .git의 HEAD·index·작업파일을 공유 → 임의 세션의
`git add -A`/`commit`이 **모든 세션의 미커밋 변경 합집합**을 포착하고, 임의 세션의
브랜치 전환이 나머지를 교란.

**제약:** 1인 개발, 빠른 반복, main 직접 커밋, 대부분 PR 게이트 없음,
self-hosted VM, push 시 Vercel 자동배포.

## Decision
동시에 도는 각 agent 세션을 **자체 `git worktree` + 단명(short-lived) 브랜치**에
격리하고, 거기서 main으로 머지/푸시한다. 사람(주 세션)은 기존 공유 클론을 유지.

## Options Considered

### Option A: 세션별 git worktree (권장)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low–Med (`git worktree add ../wt-<id> -b sess/<id>`) |
| Cost | 디스크 일부(공유 .git, 작업파일만 복제) |
| Scalability | 좋음 (N세션 = N워크트리) |
| Team familiarity | Med (worktree 개념 학습 필요) |

**Pros:** .git 공유로 가벼움; 작업파일·HEAD·index 분리 → 스윕/레이스 제거;
세션별 브랜치라 provenance 보존; harness의 `isolation: "worktree"` 옵션과 정합.
**Cons:** node_modules/.env를 워크트리마다 처리해야(심볼릭/복사); 머지 단계 추가.

### Option B: 세션별 완전 클론
**Pros:** 완전 격리.
**Cons:** 디스크·셋업(.env·DB·node_modules) 중복 큼; 동기화 번거로움. 과함.

### Option C: 세션 직렬화 + disjoint scope (현 글로벌 가이드 강화)
**Pros:** 코드 변경 0, 규율만.
**Cons:** 규율로는 레이스가 계속 발생(이 사례가 반례); 병렬성 포기.

### Option D: 현상 유지(공유 트리) — 기각
관측된 provenance 손상·레이스가 상시.

## Trade-off Analysis
B는 격리는 완벽하나 self-hosted .env/DB 셋업 중복 비용이 큼. C는 본 사례가 반례.
A가 "가벼운 .git 공유 + 작업공간 격리"로 핵심 문제(공유 index/HEAD)를 정확히
해소하며 harness 기능과도 맞물린다.

## Consequences
- **쉬워짐:** 동시 세션이 서로 안 밟음; 커밋 provenance 정확; `git status`가
  내 변경만 보여줌.
- **어려워짐:** 워크트리별 `.env`/`node_modules` 부트스트랩; main 통합(머지/리베이스) 단계.
- **재검토 대상:** 워크트리 정리 정책(머지 후 `git worktree remove`), 단명 브랜치 네이밍.

## Action Items
1. [ ] 세션 시작 래퍼: `git worktree add ~/wt/<session-id> -b sess/<session-id> origin/main`
2. [ ] `.env` 심볼릭 링크 + `node_modules`는 pnpm/심볼릭 공유 또는 워크트리별 install
3. [ ] 종료 훅: 변경 없으면 `git worktree remove`, 있으면 main으로 squash-merge 후 정리
4. [ ] 글로벌 `CLAUDE.md`에 "비자명 작업은 worktree에서" 규칙 추가(현 직렬화 권고 대체)
