export const DEFAULT_DIGEST_TOP_N = 5;
const MIN_DIGEST_TOP_N = 3;
const MAX_DIGEST_TOP_N = 7;

export function clampDigestTopN(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_DIGEST_TOP_N;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_DIGEST_TOP_N;
  return Math.max(MIN_DIGEST_TOP_N, Math.min(MAX_DIGEST_TOP_N, parsed));
}

export const TOP_RECOMMENDATIONS_SQL = `
  select l.case_no, l.item_no, l.property_type, l.address,
         l.appraisal_value::float8, l.min_bid_price::float8, l.sale_date::text,
         l.source_url, l.inq_cnt, l.interest_cnt, l.crawled_at::text,
         r.risk_grade, loc.safety_margin::float8,
         (loc.acquisition_cost->>'trueSafetyMargin')::float8 as true_margin,
         null::int as total_score, (loc.report->>'memo') as memo
    from gm_precision_shortlist p
    join gm_listings l on l.id = p.listing_id
    left join gm_rights_analysis r on r.listing_id = l.id
    left join gm_location_analysis loc on loc.listing_id = l.id
   order by
     case p.confidence when 'high' then 3 when 'medium' then 2 else 1 end desc,
     p.conservative_margin desc nulls last,
     l.sale_date asc nulls last,
     l.id asc
   limit $1`;

export const SHORTLIST_COUNT_SQL = 'select count(*)::int as c from gm_precision_shortlist';

export const HISTORICAL_RESULTS_SQL = `
  select l.case_no, l.property_type, l.address, l.appraisal_value::float8,
         r.sold, r.sold_amount::float8,
         case when r.sold and l.appraisal_value > 0 then r.sold_amount::float8 / l.appraisal_value end as sale_ratio,
         coalesce(p.status = 'recommended', false) as was_recommended
    from gm_auction_results r
    join gm_listings l on l.case_no = r.case_no and coalesce(l.item_no,'1') = r.item_no
    left join gm_precision_evaluations p on p.listing_id = l.id
   where r.kind_cd = '01' and r.dxdy_date >= current_date - 3 and r.dxdy_date < current_date
   order by r.sold desc, sale_ratio desc nulls last`;

export const UPCOMING_RECOMMENDATIONS_SQL = `
  select l.case_no, l.item_no, l.property_type, l.address, l.appraisal_value::float8, l.min_bid_price::float8,
         l.sale_date::text, l.source_url, l.inq_cnt, l.interest_cnt, l.crawled_at::text,
         r.risk_grade, loc.safety_margin::float8, (loc.acquisition_cost->>'trueSafetyMargin')::float8 as true_margin,
         null::int as total_score, null as memo
    from gm_precision_shortlist p
    join gm_listings l on l.id = p.listing_id
    left join gm_rights_analysis r on r.listing_id = l.id
    left join gm_location_analysis loc on loc.listing_id = l.id
   where l.sale_date >= current_date and l.sale_date <= current_date + 7
   order by l.sale_date,
     case p.confidence when 'high' then 3 when 'medium' then 2 else 1 end desc,
     p.conservative_margin desc nulls last,
     l.id asc`;
