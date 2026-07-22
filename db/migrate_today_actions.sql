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
