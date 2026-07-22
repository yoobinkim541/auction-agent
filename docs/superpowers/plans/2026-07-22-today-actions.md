# Today Actions Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only "오늘 할 일" queue that turns scattered listing, enrichment, fieldwork, and review signals into a prioritized dashboard strip.

**Architecture:** Postgres owns the queue rules through `gm_today_actions`. Spring exposes the view as `GET /api/actions/today?limit=20`. React loads the queue independently and opens the existing detail drawer when an action is clicked.

**Tech Stack:** PostgreSQL SQL view/migration, Spring Boot 3.3/JdbcTemplate, React 19 + TypeScript + Vite, existing Vitest tests for shared frontend logic.

## Global Constraints

- Keep the first slice read-only; do not add dismiss, snooze, assign, or job-trigger actions.
- Action types are exactly `recrawl_needed`, `rights_enrichment`, `bid_soon`, `fieldwork`, and `review_result`.
- The API route is `GET /api/actions/today?limit=20`.
- Server clamps invalid `limit` values to `1..50`.
- The dashboard strip shows at most 8 visible cards and hides itself when there are no actions.
- Clicking an action opens listing detail by `case_no` without mutating current filters or sort order.
- Do not introduce new runtime dependencies.

---

## File Structure

- `db/schema.sql`: add the canonical `gm_today_actions` view for fresh database setup.
- `db/migrate_today_actions.sql`: add the same view for existing deployments.
- `server/src/main/java/com/gyeongmae/service/ListingService.java`: add `todayActionsJson(int limit)` that reads the view.
- `server/src/main/java/com/gyeongmae/web/ListingController.java`: expose `/api/actions/today`.
- `web/src/api.ts`: add `TodayAction` type and `fetchTodayActions`.
- `web/src/useTodayActions.ts`: add independent hook so action failures do not poison listing load state.
- `web/src/TodayActions.tsx`: add small presentational component for the strip.
- `web/src/App.tsx`: load actions, refresh them after jobs, and open details on click.
- `web/src/styles.css`: add compact strip/card styling.

---

### Task 1: DB View and Migration

**Files:**
- Modify: `db/schema.sql`
- Create: `db/migrate_today_actions.sql`

**Interfaces:**
- Produces: SQL view `gm_today_actions` with columns `listing_id`, `case_no`, `item_no`, `action_type`, `priority`, `severity`, `title`, `reason`, `due_date`, `sort_date`, `source_url`.
- Consumes: existing tables/views `gm_listings`, `gm_scores`, `gm_rights_analysis`, `gm_location_analysis`, `gm_fieldwork_notes`, `gm_result_retry_queue`, `gm_outcome_eval`.

- [ ] **Step 1: Add migration with view SQL**

Create `db/migrate_today_actions.sql`:

```sql
create or replace view gm_today_actions as
with active_listings as (
  select l.id, l.case_no, coalesce(nullif(l.item_no, ''), '1') as item_no,
         l.source, l.source_url, l.sale_date, l.is_favorite,
         s.passed_filter, s.total_score,
         r.id as rights_id,
         loc.id as location_id,
         loc.report,
         loc.eviction,
         coalesce(jsonb_array_length(loc.report->'fieldwork'->'fieldChecklist'), 0) as field_total,
         coalesce((select count(*) from gm_fieldwork_notes fn where fn.listing_id = l.id and fn.checked), 0) as field_done
    from gm_listings l
    left join gm_scores s on s.listing_id = l.id
    left join gm_rights_analysis r on r.listing_id = l.id
    left join gm_location_analysis loc on loc.listing_id = l.id
   where l.sale_date is null or l.sale_date >= current_date - 2
), recrawl_needed as (
  select id as listing_id, case_no, item_no,
         'recrawl_needed'::text as action_type,
         110::int as priority,
         'danger'::text as severity,
         '재수집 필요'::text as title,
         case
           when report->>'headline' like '[데이터 불완전]%' then '등기/명세서 데이터가 불완전해 권리분석을 신뢰할 수 없습니다.'
           when rights_id is null then '권리분석 결과가 없어 재수집 또는 재분석이 필요합니다.'
           else '입지분석 결과가 없어 재분석이 필요합니다.'
         end as reason,
         null::date as due_date,
         current_date as sort_date,
         source_url
    from active_listings
   where report->>'headline' like '[데이터 불완전]%'
      or rights_id is null
      or location_id is null
), rights_enrichment as (
  select id as listing_id, case_no, item_no,
         'rights_enrichment'::text as action_type,
         75::int as priority,
         'warn'::text as severity,
         '권리 보강 필요'::text as title,
         '법원경매 원천의 점유관계가 미상입니다. deonakchal 임차인 보강 대상으로 올립니다.'::text as reason,
         null::date as due_date,
         coalesce(sale_date, current_date + 30) as sort_date,
         source_url
    from active_listings
   where source = 'courtauction'
     and eviction->>'occupantLabel' = '점유관계 미상'
     and (passed_filter = true or is_favorite = true or coalesce(total_score, 0) >= 70)
), bid_soon as (
  select id as listing_id, case_no, item_no,
         'bid_soon'::text as action_type,
         (case when sale_date = current_date then 120 else 90 - greatest(0, sale_date - current_date) end)::int as priority,
         (case when sale_date = current_date then 'danger' else 'warn' end)::text as severity,
         '입찰 임박'::text as title,
         ('매각기일이 ' || sale_date::text || '입니다. 보증금, 원본 문서, 최대입찰가를 확인하세요.')::text as reason,
         sale_date as due_date,
         sale_date as sort_date,
         source_url
    from active_listings
   where sale_date between current_date and current_date + 7
     and (passed_filter = true or is_favorite = true)
), fieldwork as (
  select id as listing_id, case_no, item_no,
         'fieldwork'::text as action_type,
         65::int as priority,
         'info'::text as severity,
         '현장 확인 남음'::text as title,
         ('임장 체크리스트 ' || field_done || '/' || field_total || ' 완료 상태입니다.')::text as reason,
         sale_date as due_date,
         coalesce(sale_date, current_date + 30) as sort_date,
         source_url
    from active_listings
   where field_total > 0
     and field_done < field_total
     and (passed_filter = true or is_favorite = true)
), review_result as (
  select l.id as listing_id, q.case_no, q.item_no,
         'review_result'::text as action_type,
         55::int as priority,
         'info'::text as severity,
         '결과 수집 복기'::text as title,
         ('매각기일이 ' || q.sale_date::text || '로 ' || q.days_overdue || '일 지났지만 결과 재시도가 남아 있습니다.')::text as reason,
         q.sale_date as due_date,
         q.sale_date as sort_date,
         l.source_url
    from gm_result_retry_queue q
    join gm_listings l on l.case_no = q.case_no and coalesce(nullif(l.item_no, ''), '1') = q.item_no
   where q.days_overdue > 0
  union all
  select l.id as listing_id, e.case_no, coalesce(nullif(e.item_no, ''), '1') as item_no,
         'review_result'::text as action_type,
         45::int as priority,
         'info'::text as severity,
         '낙찰 결과 복기'::text as title,
         case
           when e.sold and e.residual_pct > 0 then '예상보다 높은 가격에 낙찰된 케이스입니다.'
           when e.sold and (e.passed_filter = false or e.recommendation = 'avoid') then '회피/탈락 판단이었지만 낙찰된 케이스입니다.'
           when e.matched and not e.sold and e.passed_filter = true then '추천 통과였지만 유찰된 케이스입니다.'
           else '최근 결과 복기 대상입니다.'
         end as reason,
         e.sale_date as due_date,
         e.sale_date as sort_date,
         l.source_url
    from gm_outcome_eval e
    join gm_listings l on l.case_no = e.case_no and coalesce(nullif(l.item_no, ''), '1') = coalesce(nullif(e.item_no, ''), '1')
   where e.sale_date >= current_date - 14
     and (
       (e.sold and e.residual_pct > 0.15)
       or (e.sold and (e.passed_filter = false or e.recommendation = 'avoid'))
       or (e.matched and not e.sold and e.passed_filter = true)
     )
)
select * from recrawl_needed
union all select * from rights_enrichment
union all select * from bid_soon
union all select * from fieldwork
union all select * from review_result;
```

- [ ] **Step 2: Add the same view to `db/schema.sql`**

Append the exact SQL from Step 1 near the other operational/reporting views. Keep `create or replace view gm_today_actions as ...` identical to the migration.

- [ ] **Step 3: Validate SQL syntax without touching production DB**

Run:

```bash
rg -n "create or replace view gm_today_actions" db/schema.sql db/migrate_today_actions.sql
```

Expected: both files contain one `gm_today_actions` definition.

- [ ] **Step 4: Commit DB view**

```bash
git add db/schema.sql db/migrate_today_actions.sql
git commit -m "add) 오늘 할 일 큐 DB view 추가" -m "작업 내용:
- gm_today_actions view를 스키마와 마이그레이션에 추가했습니다.
- 재수집, 권리보강, 입찰임박, 현장확인, 결과복기 액션을 DB에서 산출합니다.

성과:
- 웹, 봇, 다이제스트가 재사용할 수 있는 단일 할 일 기준을 만들었습니다.

Trade-off:
- 첫 버전은 read-only 큐라 dismiss/snooze 상태는 저장하지 않습니다."
```

---

### Task 2: Spring API Endpoint

**Files:**
- Modify: `server/src/main/java/com/gyeongmae/service/ListingService.java`
- Modify: `server/src/main/java/com/gyeongmae/web/ListingController.java`

**Interfaces:**
- Consumes: DB view `gm_today_actions`.
- Produces: `ListingService.todayActionsJson(int limit): String`.
- Produces: `GET /api/actions/today?limit=20`.

- [ ] **Step 1: Add service method**

In `ListingService.java`, add this method before `mlReview()`:

```java
  /** 오늘 할 일 큐(JSON 배열 문자열) — DB view가 우선순위와 사유를 산출한다. */
  public String todayActionsJson(int requestedLimit) {
    int limit = Math.max(1, Math.min(50, requestedLimit));
    String sql = """
        select coalesce(json_agg(t order by t.priority desc, t.sort_date asc nulls last, t.case_no, t.item_no), '[]'::json)::text
          from (
            select listing_id, case_no, item_no, action_type, priority, severity,
                   title, reason, due_date::text, sort_date::text, source_url
              from gm_today_actions
             order by priority desc, sort_date asc nulls last, case_no, item_no
             limit :limit
          ) t
        """;
    return jdbc.queryForObject(sql, new MapSqlParameterSource("limit", limit), String.class);
  }
```

- [ ] **Step 2: Add controller route**

In `ListingController.java`, add this endpoint after `crawlRuns()` or before `mlReview()`:

```java
  /** 오늘 할 일 큐: 재수집·권리보강·입찰임박·현장확인·복기 액션 */
  @GetMapping(value = "/actions/today", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<String> todayActions(@RequestParam(defaultValue = "20") int limit) {
    return ResponseEntity.ok(service.todayActionsJson(limit));
  }
```

- [ ] **Step 3: Compile Spring server**

Run:

```bash
cd server && mvn test
```

Expected: Maven exits 0. If tests require unavailable local services, run `cd server && mvn -DskipTests package` and record the reason.

- [ ] **Step 4: Commit API**

```bash
git add server/src/main/java/com/gyeongmae/service/ListingService.java server/src/main/java/com/gyeongmae/web/ListingController.java
git commit -m "add) 오늘 할 일 API 추가" -m "작업 내용:
- gm_today_actions view를 읽는 ListingService.todayActionsJson을 추가했습니다.
- /api/actions/today 엔드포인트를 추가하고 limit를 1..50으로 제한했습니다.

성과:
- 대시보드가 할 일 큐를 목록 데이터와 독립적으로 조회할 수 있게 됐습니다.

Trade-off:
- 응답은 view 기반 read-only JSON으로 시작해 액션 상태 변경은 아직 지원하지 않습니다."
```

---

### Task 3: Frontend API and Hook

**Files:**
- Modify: `web/src/api.ts`
- Create: `web/src/useTodayActions.ts`

**Interfaces:**
- Produces: `TodayAction` TypeScript interface.
- Produces: `fetchTodayActions(limit?: number): Promise<TodayAction[]>`.
- Produces: `useTodayActions(limit?: number): { actions: TodayAction[]; loading: boolean; error: string | null; reload: () => void }`.

- [ ] **Step 1: Add API type and fetcher**

In `web/src/api.ts`, add after `ListingItem`:

```ts
export type TodayActionType = 'recrawl_needed' | 'rights_enrichment' | 'bid_soon' | 'fieldwork' | 'review_result';
export type TodayActionSeverity = 'danger' | 'warn' | 'info';

export interface TodayAction {
  listing_id: number;
  case_no: string;
  item_no: string;
  action_type: TodayActionType;
  priority: number;
  severity: TodayActionSeverity;
  title: string;
  reason: string;
  due_date: string | null;
  sort_date: string | null;
  source_url: string | null;
}
```

Add near other fetchers:

```ts
export async function fetchTodayActions(limit = 20): Promise<TodayAction[]> {
  const qs = new URLSearchParams();
  qs.set('limit', String(limit));
  const res = await fetch(`${BASE}/api/actions/today?${qs.toString()}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as TodayAction[];
}
```

- [ ] **Step 2: Add hook**

Create `web/src/useTodayActions.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { fetchTodayActions, type TodayAction } from './api.ts';

export function useTodayActions(limit = 20) {
  const [actions, setActions] = useState<TodayAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchTodayActions(limit)
      .then(setActions)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [limit]);

  useEffect(() => { reload(); }, [reload]);

  return { actions, loading, error, reload };
}
```

- [ ] **Step 3: Run web build**

Run:

```bash
cd web && npm run build
```

Expected: TypeScript build and Vite build succeed.

- [ ] **Step 4: Commit frontend API/hook**

```bash
git add web/src/api.ts web/src/useTodayActions.ts
git commit -m "add) 오늘 할 일 프론트 데이터 훅 추가" -m "작업 내용:
- TodayAction 타입과 fetchTodayActions API 클라이언트를 추가했습니다.
- listing 로딩과 분리된 useTodayActions 훅을 추가했습니다.

성과:
- 할 일 큐 API 장애가 기존 매물 목록 로딩을 망가뜨리지 않는 구조를 만들었습니다.

Trade-off:
- 아직 화면 표시 컴포넌트는 없고 데이터 연결만 준비했습니다."
```

---

### Task 4: Dashboard Action Strip

**Files:**
- Create: `web/src/TodayActions.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `TodayAction` from `web/src/api.ts`.
- Consumes: `useTodayActions(20)` from `web/src/useTodayActions.ts`.
- Produces: `TodayActions` component with props `{ actions, loading, error, onOpenCase }`.

- [ ] **Step 1: Add presentational component**

Create `web/src/TodayActions.tsx`:

```tsx
import type { TodayAction, TodayActionType } from './api.ts';

const LABELS: Record<TodayActionType, string> = {
  recrawl_needed: '재수집',
  rights_enrichment: '권리보강',
  bid_soon: '입찰임박',
  fieldwork: '현장확인',
  review_result: '결과복기',
};

function itemLabel(action: TodayAction): string {
  return action.item_no && action.item_no !== '1'
    ? `${action.case_no} · 물건 ${action.item_no}`
    : action.case_no;
}

export function TodayActions({ actions, loading, error, onOpenCase }: {
  actions: TodayAction[];
  loading: boolean;
  error: string | null;
  onOpenCase: (caseNo: string) => void;
}) {
  if (!loading && !error && actions.length === 0) return null;
  const visible = actions.slice(0, 8);
  const hidden = Math.max(0, actions.length - visible.length);

  return (
    <section className="today-actions" aria-label="오늘 할 일">
      <div className="today-actions-head">
        <div>
          <span className="today-actions-kicker">오늘 할 일</span>
          <b>{loading ? '불러오는 중…' : `${actions.length}건`}</b>
        </div>
        {hidden > 0 && <span className="today-actions-more">외 {hidden}건</span>}
      </div>
      {error ? (
        <p className="today-actions-error">할 일 큐를 불러오지 못했습니다: {error}</p>
      ) : (
        <div className="today-actions-list">
          {visible.map((action) => (
            <button
              key={`${action.action_type}:${action.listing_id}:${action.due_date ?? ''}`}
              className={`today-action-card today-action-${action.severity}`}
              onClick={() => onOpenCase(action.case_no)}
              title={action.reason}
            >
              <span className="today-action-type">{LABELS[action.action_type]}</span>
              <strong>{action.title}</strong>
              <span className="today-action-case">{itemLabel(action)}</span>
              <span className="today-action-reason">{action.reason}</span>
              {action.due_date && <span className="today-action-date">{action.due_date}</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Wire hook into `App.tsx`**

In `web/src/App.tsx`, add imports:

```ts
import { useTodayActions } from './useTodayActions.ts';
import { TodayActions } from './TodayActions.tsx';
```

Inside `App()`, after `const { rows, setRows, loading, err, lastCrawl, load } = useListings();` add:

```ts
  const { actions: todayActions, loading: todayActionsLoading, error: todayActionsError, reload: reloadTodayActions } = useTodayActions(20);
```

In `runJob`, where a job completes successfully and calls `load();`, add:

```ts
              reloadTodayActions();
```

Update the `runJob` callback dependency is not explicit because `runJob` is an inline function in `App`; no dependency array change is needed.

Add this JSX after the stat banner/week calendar block and before `<div className="controls">`:

```tsx
      <TodayActions
        actions={todayActions}
        loading={todayActionsLoading}
        error={todayActionsError}
        onOpenCase={openCaseFromReview}
      />
```

- [ ] **Step 3: Add styles**

Append to `web/src/styles.css`:

```css
.today-actions {
  margin: 12px 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}
.today-actions-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.today-actions-kicker {
  display: block;
  color: var(--muted);
  font-size: 12px;
}
.today-actions-more,
.today-actions-error {
  color: var(--muted);
  font-size: 13px;
}
.today-actions-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
}
.today-action-card {
  display: grid;
  gap: 4px;
  min-height: 120px;
  padding: 10px;
  text-align: left;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  color: inherit;
  cursor: pointer;
}
.today-action-card:hover {
  border-color: var(--accent);
}
.today-action-type,
.today-action-date {
  color: var(--muted);
  font-size: 12px;
}
.today-action-case {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}
.today-action-reason {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.35;
}
.today-action-danger {
  border-left: 4px solid #dc2626;
}
.today-action-warn {
  border-left: 4px solid #f59e0b;
}
.today-action-info {
  border-left: 4px solid #2563eb;
}
```

- [ ] **Step 4: Build web**

Run:

```bash
cd web && npm run build
```

Expected: build exits 0.

- [ ] **Step 5: Commit dashboard strip**

```bash
git add web/src/TodayActions.tsx web/src/App.tsx web/src/styles.css
git commit -m "add) 대시보드 오늘 할 일 큐 표시" -m "작업 내용:
- 오늘 할 일 스트립 컴포넌트를 추가했습니다.
- App에서 할 일 큐를 독립 로드하고 카드 클릭 시 기존 상세 드로어를 열도록 연결했습니다.
- 위험도별 카드 스타일을 추가했습니다.

성과:
- 사용자가 매일 확인해야 할 재수집, 보강, 입찰, 현장확인, 복기 항목을 한 화면에서 볼 수 있게 됩니다.

Trade-off:
- 첫 버전은 상위 8개 카드만 표시하고 별도 전체 할 일 페이지는 만들지 않았습니다."
```

---

### Task 5: End-to-End Verification and Final Commit Check

**Files:**
- No new files expected.
- Verify all files changed by Tasks 1-4.

**Interfaces:**
- Consumes: DB migration, Spring endpoint, frontend hook/component.
- Produces: verified working slice ready for manual DB migration/deploy.

- [ ] **Step 1: Run root TypeScript tests**

Run:

```bash
npm test
```

Expected: all existing Vitest tests pass.

- [ ] **Step 2: Run root TypeScript check**

Run:

```bash
npm run typecheck
```

Expected: TypeScript check exits 0.

- [ ] **Step 3: Run web build**

Run:

```bash
cd web && npm run build
```

Expected: `tsc -b` and `vite build` exit 0.

- [ ] **Step 4: Run Spring build**

Run:

```bash
cd server && mvn test
```

Expected: Maven exits 0. If the environment cannot download Maven dependencies because network is blocked, retry once with approved network access. If it still fails for external reasons, record the exact error in the final handoff.

- [ ] **Step 5: Inspect changed files**

Run:

```bash
git status --short
```

Expected: only intentional files from the plan are modified, plus unrelated pre-existing worktree changes that were present before execution. Do not revert unrelated changes.

- [ ] **Step 6: Final handoff**

Report:

- DB migration file to run: `db/migrate_today_actions.sql`
- API endpoint: `/api/actions/today?limit=20`
- Validation commands and results
- Any commands that could not run and why
