import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { pool, query } from '../shared/db.ts';

export interface StatusCount {
  status: string;
  count: number;
}

export interface HoldQuarantineReason {
  scope: 'listing_trust' | 'outcome_trust' | 'precision';
  status: string;
  reason: string;
  count: number;
}

export interface PrecisionAuditMetrics {
  safety: {
    recommendedNonTrusted: number;
    recommendedAssumedAmount: number;
    recommendedHardCapBelowMinBid: number;
    duplicateCaseRepresentatives: number;
    shortlistCount: number;
  };
  precisionStatusDistribution: StatusCount[];
  listingTrustStatusDistribution: StatusCount[];
  outcomeTrustStatusDistribution: StatusCount[];
  topHoldQuarantineReasons: HoldQuarantineReason[];
  decisionConversion: {
    recommended: number;
    decided: number;
    conversionRate: number;
    byDecision: Record<string, number>;
  };
  trustedOutcomeCoverage: {
    raw: number;
    evaluated: number;
    trusted: number;
    hold: number;
    quarantined: number;
    trustedRate: number;
  };
}

export interface AuditMessage {
  code: string;
  count?: number;
  message: string;
}

export interface PrecisionAuditResult {
  ok: boolean;
  failures: AuditMessage[];
  warnings: AuditMessage[];
  metrics: PrecisionAuditMetrics;
}

const failure = (code: string, count: number, message: string): AuditMessage => ({ code, count, message });

export function auditResult(metrics: PrecisionAuditMetrics): PrecisionAuditResult {
  const failures: AuditMessage[] = [];
  const { safety } = metrics;

  if (safety.recommendedNonTrusted > 0) {
    failures.push(failure('RECOMMENDED_NON_TRUSTED', safety.recommendedNonTrusted, 'recommended 행에 trusted가 아닌 데이터가 있습니다'));
  }
  if (safety.recommendedAssumedAmount > 0) {
    failures.push(failure('RECOMMENDED_ASSUMED_AMOUNT', safety.recommendedAssumedAmount, 'recommended 행에 0원이 아닌 인수금액이 있습니다'));
  }
  if (safety.recommendedHardCapBelowMinBid > 0) {
    failures.push(failure('RECOMMENDED_HARD_CAP_BELOW_MIN_BID', safety.recommendedHardCapBelowMinBid, 'recommended 행의 절대 상한이 최저가보다 낮습니다'));
  }
  if (safety.duplicateCaseRepresentatives > 0) {
    failures.push(failure('DUPLICATE_CASE_REPRESENTATIVES', safety.duplicateCaseRepresentatives, '정밀 후보에 동일 사건 대표가 중복되었습니다'));
  }
  if (safety.shortlistCount > 7) {
    failures.push(failure('SHORTLIST_ABOVE_WEEKLY_CAP', safety.shortlistCount, '정밀 후보가 주간 상한 7건을 초과했습니다'));
  }

  const warnings = safety.shortlistCount === 0
    ? [{ code: 'ZERO_RECOMMENDATIONS', message: '현재 정밀 추천이 0건입니다. 게이트를 완화하지 말고 입력 데이터와 보류 사유를 확인하세요' }]
    : [];

  return { ok: failures.length === 0, failures, warnings, metrics };
}

export const PRECISION_AUDIT_SQL = `
with safety as (
  select
    (select count(*)::int
       from gm_precision_evaluations p
       left join gm_data_trust t on t.listing_id = p.listing_id
      where p.status = 'recommended' and t.status is distinct from 'trusted') as recommended_non_trusted,
     (select count(*)::int
        from gm_precision_evaluations p
       left join gm_rights_analysis r on r.listing_id = p.listing_id
      where p.status = 'recommended' and r.assumed_amount is distinct from 0) as recommended_assumed_amount,
    (select count(*)::int
       from gm_precision_evaluations p
       join gm_listings l on l.id = p.listing_id
      where p.status = 'recommended'
        and (p.hard_cap_bid is null or p.hard_cap_bid < l.min_bid_price)) as recommended_hard_cap_below_min_bid,
    (select coalesce(sum(duplicates - 1), 0)::int
       from (select count(*)::int as duplicates from gm_precision_shortlist group by case_no having count(*) > 1) grouped) as duplicate_case_representatives,
    (select count(*)::int from gm_precision_shortlist) as shortlist_count
), precision_status as (
  select coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', rows) order by status), '[]'::jsonb) as rows
    from (select status, count(*)::int as rows from gm_precision_evaluations group by status) grouped
), listing_trust_status as (
  select coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', rows) order by status), '[]'::jsonb) as rows
    from (select status, count(*)::int as rows from gm_data_trust group by status) grouped
), outcome_trust_status as (
  select coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', rows) order by status), '[]'::jsonb) as rows
    from (select status, count(*)::int as rows from gm_outcome_trust group by status) grouped
), reason_counts as (
  select 'listing_trust'::text as scope, t.status, reason, count(*)::int as rows
    from gm_data_trust t
    cross join lateral jsonb_array_elements_text(t.reason_codes) as reasons(reason)
   where t.status in ('hold', 'quarantined')
   group by t.status, reason
  union all
  select 'outcome_trust'::text as scope, t.status, reason, count(*)::int as rows
    from gm_outcome_trust t
    cross join lateral jsonb_array_elements_text(t.reason_codes) as reasons(reason)
   where t.status in ('hold', 'quarantined')
   group by t.status, reason
  union all
  select 'precision'::text as scope, p.status, reason, count(*)::int as rows
    from gm_precision_evaluations p
    cross join lateral jsonb_array_elements_text(p.reason_codes) as reasons(reason)
   where p.status = 'hold'
   group by p.status, reason
), top_reasons as (
  select coalesce(jsonb_agg(jsonb_build_object(
           'scope', scope, 'status', status, 'reason', reason, 'count', rows
         ) order by rows desc, scope, status, reason), '[]'::jsonb) as rows
    from (select * from reason_counts order by rows desc, scope, status, reason limit 10) ranked
), decision_counts as (
  select d.decision, count(*)::int as rows
    from gm_precision_shortlist p
    join gm_current_decisions d on d.listing_id = p.listing_id
   group by d.decision
), decision_conversion as (
  select
    (select shortlist_count from safety) as recommended,
    coalesce((select sum(rows)::int from decision_counts), 0) as decided,
    case when (select shortlist_count from safety) = 0 then 0::float8
         else coalesce((select sum(rows)::float8 from decision_counts), 0) / (select shortlist_count from safety)
    end as conversion_rate,
    coalesce((select jsonb_object_agg(decision, rows order by decision) from decision_counts), '{}'::jsonb) as by_decision
), outcome_coverage as (
  select count(*)::int as raw,
         count(t.case_no)::int as evaluated,
         count(*) filter (where t.status = 'trusted')::int as trusted,
         count(*) filter (where t.status = 'hold')::int as hold,
         count(*) filter (where t.status = 'quarantined')::int as quarantined
    from gm_outcome_eval e
    left join gm_outcome_trust t
      on t.case_no = e.case_no
     and t.item_no = coalesce(nullif(e.item_no, ''), '1')
     and t.sale_date = e.sale_date
)
select jsonb_build_object(
  'safety', jsonb_build_object(
    'recommendedNonTrusted', safety.recommended_non_trusted,
    'recommendedAssumedAmount', safety.recommended_assumed_amount,
    'recommendedHardCapBelowMinBid', safety.recommended_hard_cap_below_min_bid,
    'duplicateCaseRepresentatives', safety.duplicate_case_representatives,
    'shortlistCount', safety.shortlist_count
  ),
  'precisionStatusDistribution', precision_status.rows,
  'listingTrustStatusDistribution', listing_trust_status.rows,
  'outcomeTrustStatusDistribution', outcome_trust_status.rows,
  'topHoldQuarantineReasons', top_reasons.rows,
  'decisionConversion', jsonb_build_object(
    'recommended', decision_conversion.recommended,
    'decided', decision_conversion.decided,
    'conversionRate', decision_conversion.conversion_rate,
    'byDecision', decision_conversion.by_decision
  ),
  'trustedOutcomeCoverage', jsonb_build_object(
    'raw', outcome_coverage.raw,
    'evaluated', outcome_coverage.evaluated,
    'trusted', outcome_coverage.trusted,
    'hold', outcome_coverage.hold,
    'quarantined', outcome_coverage.quarantined,
    'trustedRate', case when outcome_coverage.raw = 0 then 0::float8
                        else outcome_coverage.trusted::float8 / outcome_coverage.raw end
  )
) as metrics
from safety, precision_status, listing_trust_status, outcome_trust_status,
     top_reasons, decision_conversion, outcome_coverage`;

export async function readAuditMetrics(): Promise<PrecisionAuditMetrics> {
  const row = (await query<{ metrics: PrecisionAuditMetrics }>(PRECISION_AUDIT_SQL))[0];
  if (!row) throw new Error('정밀 감사 SQL이 결과를 반환하지 않았습니다');
  return row.metrics;
}

export async function main(): Promise<void> {
  const result = auditResult(await readAuditMetrics());
  console.log(JSON.stringify(result, null, 2));
  await pool().end();
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
