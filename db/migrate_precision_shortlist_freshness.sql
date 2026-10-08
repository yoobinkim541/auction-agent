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
      partition by l.case_no
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

commit;
