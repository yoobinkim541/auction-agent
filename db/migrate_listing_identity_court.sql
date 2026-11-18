-- 매물 식별 키에 법원을 넣는다: (case_no, item_no) → (court, case_no, item_no).
-- 사건번호는 법원마다 따로 매겨져 같은 번호가 여러 법원에 있다. 법원 없이 묶으면 한 행을 여러 법원이 번갈아 덮어쓰고
-- 결과·스냅샷이 다른 법원 물건에 붙는다.
-- 다시 실행해도 된다. 코드 배포와 함께 적용한다(구 코드의 on conflict 대상이 사라진다).
-- 표마다 따로 커밋한다. 한 트랜잭션으로 묶으면 과거 행을 채우는 몇 분 동안 gm_listings 를 읽는 쪽이 전부 멈춘다.
-- 적용: psql -v ON_ERROR_STOP=1 -f db/migrate_listing_identity_court.sql (임시 표·함수를 쓰므로 한 세션에서)

-- 담당계 표기('인천8계')를 법원명으로. crawler/adapters/courtauction.ts 의 canonicalCourt 와 같은 규칙.
create temporary table _court_map (prefix text primary key, court text not null);
insert into _court_map values
  ('서울중앙','서울중앙지방법원'), ('서울동부','서울동부지방법원'), ('서울남부','서울남부지방법원'),
  ('서울북부','서울북부지방법원'), ('서울서부','서울서부지방법원'), ('의정부','의정부지방법원'),
  ('남양주','남양주지원'), ('고양','고양지원'), ('인천','인천지방법원'), ('부천','부천지원'),
  ('수원','수원지방법원'), ('성남','성남지원'), ('여주','여주지원'), ('평택','평택지원'),
  ('안산','안산지원'), ('안양','안양지원');

create function pg_temp.canon_court(raw text) returns text language sql stable as $$
  select coalesce((select m.court from _court_map m where m.prefix = regexp_replace(btrim(raw), '\d+계.*$', '')), btrim(raw))
$$;

begin;
update gm_listings set court = pg_temp.canon_court(court) where court ~ '\d+계';
update gm_auction_results set court = pg_temp.canon_court(court) where court ~ '\d+계';
update gm_feature_snapshots set court = pg_temp.canon_court(court) where court ~ '\d+계';

alter table gm_listings drop constraint if exists gm_listings_case_no_item_no_source_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'gm_listings_court_case_item_source_key' and conrelid = 'gm_listings'::regclass) then
    alter table gm_listings add constraint gm_listings_court_case_item_source_key unique (court, case_no, item_no, source);
  end if;
end $$;
create index if not exists gm_listings_case_item_idx on gm_listings (case_no, item_no);

-- 결과 행의 court 는 그 결과를 조회한 법원이라 그대로 믿는다. 비어 있으면 매물에서 가져온다.
update gm_auction_results r
   set court = coalesce((select l.court from gm_listings l where l.case_no = r.case_no and l.item_no = r.item_no
                          order by (l.source = 'courtauction') desc, l.crawled_at desc nulls last, l.id desc limit 1), '')
 where r.court is null;
alter table gm_auction_results alter column court set not null;
alter table gm_auction_results drop constraint if exists gm_auction_results_case_no_item_no_dxdy_date_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'gm_auction_results_court_case_item_dxdy_key' and conrelid = 'gm_auction_results'::regclass) then
    alter table gm_auction_results add constraint gm_auction_results_court_case_item_dxdy_key unique (court, case_no, item_no, dxdy_date);
  end if;
end $$;
create index if not exists gm_auction_results_case_item_idx on gm_auction_results (case_no, item_no);
commit;

-- 기일(d)을 가진 과거 행이 어느 법원 것이었는지. 앞에서부터 처음 맞는 것:
--   1) 지금 매물이 그 기일을 겨누고 있다  2) 그 기일의 입력 스냅샷에 적힌 법원  3) 그 기일에 결과가 확정된 법원
--   4) 그 기일이 잡혀 있던 법원  5) 기일이 가장 가까운 결과의 법원  6) 지금 매물의 법원  7) 알 수 없음('')
create function pg_temp.court_for(c text, i text, d date) returns text language sql stable as $$
  select coalesce(
    (select l.court from gm_listings l where l.case_no = c and l.item_no = i and l.sale_date = d
      order by (l.source = 'courtauction') desc, l.crawled_at desc nulls last, l.id desc limit 1),
    (select f.court from gm_feature_snapshots f where f.case_no = c and f.item_no = i and f.sale_date = d and f.court is not null
      order by f.horizon_days limit 1),
    (select r.court from gm_auction_results r where r.case_no = c and r.item_no = i and r.dxdy_date = d and r.result_cd is not null limit 1),
    (select r.court from gm_auction_results r where r.case_no = c and r.item_no = i and r.dxdy_date = d limit 1),
    (select r.court from gm_auction_results r where r.case_no = c and r.item_no = i order by abs(r.dxdy_date - d), r.dxdy_date limit 1),
    (select l.court from gm_listings l where l.case_no = c and l.item_no = i
      order by (l.source = 'courtauction') desc, l.crawled_at desc nulls last, l.id desc limit 1),
    '')
$$;

-- 입력 스냅샷은 기록 당시 매물의 법원을 이미 갖고 있다. 비어 있는 행만 채운다.
begin;
update gm_feature_snapshots set court = pg_temp.court_for(case_no, item_no, sale_date) where court is null;
alter table gm_feature_snapshots alter column court set not null;
alter table gm_feature_snapshots drop constraint if exists gm_feature_snapshots_pkey;
alter table gm_feature_snapshots add constraint gm_feature_snapshots_pkey primary key (court, case_no, item_no, sale_date, horizon_days);
commit;

begin;
alter table gm_prediction_snapshots add column if not exists court text;
update gm_prediction_snapshots set court = pg_temp.court_for(case_no, item_no, sale_date) where court is null;
alter table gm_prediction_snapshots alter column court set not null;
alter table gm_prediction_snapshots drop constraint if exists gm_prediction_snapshots_case_no_item_no_sale_date_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'gm_prediction_snapshots_court_case_item_sale_key' and conrelid = 'gm_prediction_snapshots'::regclass) then
    alter table gm_prediction_snapshots add constraint gm_prediction_snapshots_court_case_item_sale_key unique (court, case_no, item_no, sale_date);
  end if;
end $$;
commit;

begin;
alter table gm_outcome_trust add column if not exists court text;
update gm_outcome_trust set court = pg_temp.court_for(case_no, item_no, sale_date) where court is null;
alter table gm_outcome_trust alter column court set not null;
alter table gm_outcome_trust drop constraint if exists gm_outcome_trust_pkey;
alter table gm_outcome_trust add constraint gm_outcome_trust_pkey primary key (court, case_no, item_no, sale_date);
commit;

begin;
alter table gm_avm_estimates add column if not exists court text;
update gm_avm_estimates set court = pg_temp.court_for(case_no, item_no, sale_date) where court is null;
alter table gm_avm_estimates alter column court set not null;
alter table gm_avm_estimates drop constraint if exists gm_avm_estimates_pkey;
alter table gm_avm_estimates add constraint gm_avm_estimates_pkey primary key (court, case_no, item_no, sale_date);
commit;

begin;
alter table gm_result_retry_status add column if not exists court text;
update gm_result_retry_status set court = pg_temp.court_for(case_no, item_no, sale_date) where court is null;
alter table gm_result_retry_status alter column court set not null;
alter table gm_result_retry_status drop constraint if exists gm_result_retry_status_pkey;
alter table gm_result_retry_status add constraint gm_result_retry_status_pkey primary key (court, case_no, item_no, sale_date);
commit;

begin;
alter table gm_shadow_scores add column if not exists court text;
update gm_shadow_scores set court = pg_temp.court_for(case_no, item_no, sale_date) where court is null;
alter table gm_shadow_scores alter column court set not null;
alter table gm_shadow_scores drop constraint if exists gm_shadow_scores_case_no_item_no_sale_date_model_name_model_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'gm_shadow_scores_court_case_item_sale_model_key' and conrelid = 'gm_shadow_scores'::regclass) then
    alter table gm_shadow_scores add constraint gm_shadow_scores_court_case_item_sale_model_key
      unique (court, case_no, item_no, sale_date, model_name, model_version);
  end if;
end $$;
drop index if exists gm_shadow_scores_case_sale_idx; -- 새 유니크 키의 앞부분과 겹친다
commit;

do $$ begin
  if to_regclass('gm_postmortems') is not null then
    alter table gm_postmortems add column if not exists court text;
    update gm_postmortems set court = pg_temp.court_for(case_no, item_no, sale_date) where court is null;
    alter table gm_postmortems alter column court set not null;
    alter table gm_postmortems drop constraint if exists gm_postmortems_pkey;
    alter table gm_postmortems add constraint gm_postmortems_pkey primary key (court, case_no, item_no, sale_date, surprise_type);
  end if;
end $$;

-- 관심·조회 수 이력은 기일이 없다. 결과가 한 법원에만 있으면 그 법원. 여러 법원이면 그날 이후 가장 가까운 기일의 법원,
-- 없으면 가장 가까운 기일의 법원. 결과가 없으면 지금 매물의 법원.
begin;
alter table gm_competition_history add column if not exists court text;
update gm_competition_history h
   set court = k.court
  from (select case_no, item_no, min(court) as court from gm_auction_results group by case_no, item_no having count(distinct court) = 1) k
 where h.court is null and h.case_no = k.case_no and h.item_no = k.item_no;
update gm_competition_history h
   set court = coalesce(
     (select r.court from gm_auction_results r where r.case_no = h.case_no and r.item_no = h.item_no and r.dxdy_date >= h.captured_date
       order by r.dxdy_date limit 1),
     (select r.court from gm_auction_results r where r.case_no = h.case_no and r.item_no = h.item_no
       order by abs(r.dxdy_date - h.captured_date), r.dxdy_date limit 1))
 where h.court is null
   and exists (select 1 from gm_auction_results r where r.case_no = h.case_no and r.item_no = h.item_no);
update gm_competition_history h
   set court = k.court
  from (select distinct on (case_no, item_no) case_no, item_no, court from gm_listings
         order by case_no, item_no, (source = 'courtauction') desc, crawled_at desc nulls last, id desc) k
 where h.court is null and h.case_no = k.case_no and h.item_no = k.item_no;
update gm_competition_history set court = '' where court is null;
alter table gm_competition_history alter column court set not null;
alter table gm_competition_history drop constraint if exists gm_competition_history_pkey;
alter table gm_competition_history add constraint gm_competition_history_pkey primary key (court, case_no, item_no, captured_date);
commit;

-- 뷰: 조인·묶음에 법원을 넣는다. 컬럼 구성은 그대로(gm_rights_risk_eval 만 끝에 court 추가).
begin;
create or replace view gm_precision_shortlist as
with eligible as (
  select
    l.id as listing_id,
    l.case_no,
    l.item_no,
    l.address,
    l.property_type,
    l.sale_date,
    l.min_bid_price,
    t.status as trust_status,
    r.assumed_amount,
    p.status,
    p.confidence,
    p.conservative_value,
    p.recommended_bid,
    p.hard_cap_bid,
    p.reason_codes,
    p.strengths,
    p.risks,
    p.required_checks,
    p.evaluator_version,
    p.evaluated_at,
    p.conservative_value - p.recommended_bid as conservative_margin,
    row_number() over (
      partition by l.court, l.case_no
      order by
        case p.confidence when 'high' then 3 when 'medium' then 2 else 1 end desc,
        p.conservative_value - p.recommended_bid desc nulls last,
        l.sale_date asc nulls last,
        l.id asc
    ) as case_rank
  from gm_precision_evaluations p
  join gm_listings l on l.id = p.listing_id
  join gm_data_trust t on t.listing_id = l.id
  join gm_rights_analysis r on r.listing_id = l.id
  join gm_location_analysis loc on loc.listing_id = l.id
  where p.status = 'recommended'
    and (l.sale_date is null or l.sale_date >= current_date)
    and t.status = 'trusted'
    and p.evaluated_at >= l.crawled_at
    and t.evaluated_at >= l.crawled_at
    and r.analyzed_at >= l.crawled_at
    and loc.analyzed_at >= l.crawled_at
    and r.assumed_amount = 0
    and coalesce(loc.report->>'recommendation', '') <> 'avoid'
    and p.hard_cap_bid >= l.min_bid_price
    and p.recommended_bid is not null
    and p.recommended_bid >= l.min_bid_price
    and p.recommended_bid <= p.hard_cap_bid
)
select
  listing_id, case_no, item_no, address, property_type, sale_date, min_bid_price,
  trust_status, assumed_amount, status, confidence, conservative_value, recommended_bid,
  hard_cap_bid, reason_codes, strengths, risks, required_checks, evaluator_version,
  evaluated_at, conservative_margin
from eligible
where case_rank = 1
order by
  case confidence when 'high' then 3 when 'medium' then 2 else 1 end desc,
  conservative_margin desc nulls last,
  sale_date asc nulls last,
  listing_id asc;

create or replace view gm_outcome_eval as
  with L as (
    select distinct on (court, case_no, item_no) court, case_no, item_no,
           property_type, address, appraisal_value
      from gm_listings order by court, case_no, item_no, crawled_at desc nulls last, id desc
  )
  select s.case_no, s.item_no, s.sale_date,
         l.property_type, s.court, l.address, coalesce(s.appraisal_value, l.appraisal_value) as appraisal_value,
         s.expected_bid, s.market_price, s.min_bid_price, s.total_score, s.passed_filter,
         s.recommendation, s.true_margin, s.max_safe_bid, s.inq_cnt, s.interest_cnt,
         r.sold, r.sold_amount, r.result_cd, r.min_price as result_min_price,
         (r.dxdy_date is not null) as matched,
         case when r.sold then r.sold_amount - s.expected_bid end as residual,
         case when r.sold and s.expected_bid > 0 then (r.sold_amount - s.expected_bid)::float8 / s.expected_bid end as residual_pct,
         case when r.sold and coalesce(s.appraisal_value, l.appraisal_value) > 0 then r.sold_amount::float8 / coalesce(s.appraisal_value, l.appraisal_value) end as sale_ratio,
         case when r.sold and s.max_safe_bid is not null then r.sold_amount <= s.max_safe_bid end as would_have_won_under_max_safe_bid,
         case when r.sold and s.market_price > 0 then (s.market_price - r.sold_amount)::float8 / s.market_price end as realized_bid_margin
    from gm_prediction_snapshots s
    join L l on l.court = s.court and l.case_no = s.case_no and l.item_no = s.item_no
    left join gm_auction_results r on r.court = s.court and r.case_no = s.case_no and r.item_no = s.item_no and r.dxdy_date = s.sale_date;

create or replace view gm_trusted_outcome_eval as
  select e.*
    from gm_outcome_eval e
    join gm_outcome_trust t
     on t.court = e.court
     and t.case_no = e.case_no
     and t.item_no = coalesce(nullif(e.item_no, ''), '1')
     and t.sale_date = e.sale_date
   where t.status = 'trusted'
     and t.sold is not distinct from e.sold
     and t.appraisal_value is not distinct from e.appraisal_value
     and t.sold_amount is not distinct from e.sold_amount;

create or replace view gm_rights_risk_eval as
  -- 최신 매물은 (court, case_no, item_no) 인덱스로 행마다 찾는다. 세 컬럼 조인은 플래너가 결과를
  -- 1~2행으로 잡아 중첩 루프로 매물 전체를 행마다 다시 훑는다(복기 API 4분 이상).
  select e.case_no, coalesce(nullif(e.item_no,''),'1') as item_no, e.sale_date, e.matched, e.sold,
         e.sold_amount, e.sale_ratio, e.realized_bid_margin, e.would_have_won_under_max_safe_bid,
         r.risk_grade, r.assumed_amount, r.max_safe_bid,
         jsonb_array_length(coalesce(r.tenants, '[]'::jsonb)) as tenant_count,
         exists (
           select 1 from jsonb_array_elements(coalesce(r.tenants, '[]'::jsonb)) t
            where coalesce((t->>'hasOpposition')::boolean, false)
         ) as has_opposition_tenant,
         jsonb_array_length(coalesce(r.red_flags, '[]'::jsonb)) as red_flag_count,
         e.court
    from gm_trusted_outcome_eval e
    left join lateral (
      select g.id as listing_id
        from gm_listings g
       where g.court = e.court and g.case_no = e.case_no and g.item_no = coalesce(nullif(e.item_no,''),'1')
       order by g.crawled_at desc nulls last, g.id desc
       limit 1
    ) l on true
    left join gm_rights_analysis r on r.listing_id = l.listing_id
   where e.sale_date < current_date;

create or replace view gm_result_retry_queue as
  select e.case_no, coalesce(nullif(e.item_no,''),'1') as item_no, e.sale_date, e.court, e.property_type, e.address,
         (current_date - e.sale_date)::int as days_overdue,
         e.total_score, e.passed_filter, e.recommendation, e.expected_bid, e.min_bid_price, e.inq_cnt, e.interest_cnt,
         coalesce(rs.attempts, 0) as retry_attempts,
         rs.last_status as retry_last_status,
         rs.last_attempted_at as retry_last_attempted_at,
         case
           when e.sale_date < current_date - 14 then 100
           when e.passed_filter then 80
           when e.total_score >= 70 then 70
           else 50
         end as retry_priority
    from gm_outcome_eval e
    left join gm_result_retry_status rs
      on rs.court = e.court
     and rs.case_no = e.case_no
     and rs.item_no = coalesce(nullif(e.item_no,''),'1')
     and rs.sale_date = e.sale_date
   where e.sale_date < current_date
     and e.matched = false
     and coalesce(rs.last_status, 'pending') <> 'success'
     and (rs.last_attempted_at is null or rs.last_attempted_at < now() - interval '24 hours')
   order by retry_priority desc, e.sale_date desc, e.case_no, item_no;

create or replace view gm_shadow_score_eval as
  select s.id, s.case_no, s.item_no, s.sale_date, s.model_name, s.model_version,
         s.predicted_sale_ratio, s.confidence, s.feature_snapshot_hash, s.created_at,
         e.property_type, s.court, e.address, e.appraisal_value, e.matched, e.sold,
         e.sold_amount, e.sale_ratio, e.realized_bid_margin,
         case when e.sale_ratio is not null then s.predicted_sale_ratio - e.sale_ratio end as sale_ratio_error,
         case when e.sale_ratio is not null then abs(s.predicted_sale_ratio - e.sale_ratio) end as abs_sale_ratio_error,
         (e.sale_date <= current_date - 14) as eligible_for_review,
         s.conservative_sale_ratio
    from gm_shadow_scores s
    left join gm_trusted_outcome_eval e
      on e.court = s.court
     and e.case_no = s.case_no
     and coalesce(nullif(e.item_no,''),'1') = s.item_no
     and e.sale_date = s.sale_date;

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
    join gm_listings l on l.court = q.court and l.case_no = q.case_no and coalesce(nullif(l.item_no, ''), '1') = q.item_no
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
    join gm_listings l on l.court = e.court and l.case_no = e.case_no and coalesce(nullif(l.item_no, ''), '1') = coalesce(nullif(e.item_no, ''), '1')
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

commit;
