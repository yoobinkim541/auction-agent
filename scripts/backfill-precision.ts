import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { savePrecisionEvaluation, query } from '../shared/db.ts';
import type { Listing, LocationAnalysis, RightsAnalysisResult } from '../shared/types.ts';
import { evaluatePrecision, type PrecisionTrustStatus } from '../pipeline/precision/evaluate.ts';
import {
  buildPrecisionInput, hashEvaluationInput, internalEvaluationHold,
} from '../pipeline/precision/input.ts';

const DEFAULT_LIMIT = 5000;

export interface PrecisionBackfillOptions {
  limit: number;
  sinceDays: number | null;
}

interface PrecisionBackfillRow {
  id: number;
  case_no: string;
  item_no: string | null;
  court: string;
  address: string;
  property_type: Listing['propertyType'];
  appraisal_value: string | number | null;
  min_bid_price: string | number | null;
  fail_count: number | null;
  source: Listing['source'];
  crawled_at: string | Date;
  trust_status: string | null;
  classified: unknown;
  tenants: unknown;
  assumed_amount: string | number | null;
  max_safe_bid: string | number | null;
  red_flags: unknown;
  risk_grade: string | null;
  warnings: unknown;
  market_price: string | number | null;
  market_confidence: string | null;
  comps: unknown;
  expected_bid_price: string | number | null;
  acquisition_cost: unknown;
  site_comps: unknown;
  eviction: unknown;
}

export const PRECISION_BACKFILL_SQL = `
  select l.id, l.case_no, l.item_no, l.court, l.address, l.property_type,
         l.appraisal_value, l.min_bid_price, l.fail_count, l.source, l.crawled_at,
         t.status as trust_status,
         r.classified, r.tenants, r.assumed_amount, r.max_safe_bid, r.red_flags, r.risk_grade, r.warnings,
         loc.market_price, loc.market_confidence, loc.comps, loc.expected_bid_price,
         loc.acquisition_cost, loc.site_comps, loc.eviction
    from gm_listings l
    left join gm_data_trust t on t.listing_id = l.id
    left join gm_rights_analysis r on r.listing_id = l.id
    left join gm_location_analysis loc on loc.listing_id = l.id
    left join gm_precision_evaluations current_precision on current_precision.listing_id = l.id
   where $2::int is null
      or (greatest(l.crawled_at, r.analyzed_at, loc.analyzed_at, t.evaluated_at)
            >= now() - make_interval(days => $2::int)
          and (current_precision.evaluated_at is null
            or current_precision.evaluated_at < greatest(
              l.crawled_at, r.analyzed_at, loc.analyzed_at, t.evaluated_at
            )))
   order by greatest(l.crawled_at, r.analyzed_at, loc.analyzed_at, t.evaluated_at) desc, l.id desc
   limit $1`;

const numberOrNull = (value: string | number | null): number | null => {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const numberOrZero = (value: string | number | null): number => numberOrNull(value) ?? 0;

const array = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

const trustStatus = (value: string | null): PrecisionTrustStatus => (
  value === 'trusted' || value === 'quarantined' ? value : 'hold'
);

const riskGrade = (value: string | null): RightsAnalysisResult['riskGrade'] => (
  value === 'clean' || value === 'caution' || value === 'risky' ? value : 'review_required'
);

export function readPrecisionBackfillOptions(
  args: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env,
): PrecisionBackfillOptions {
  const cliLimit = args.find((arg) => arg.startsWith('--limit='));
  const rawLimit = cliLimit === undefined ? env.PRECISION_BACKFILL_LIMIT : cliLimit.slice('--limit='.length);
  const parsedLimit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  const sinceDaysArg = args.find((arg) => arg.startsWith('--since-days='));
  const sinceDays = sinceDaysArg === undefined ? null : Number(sinceDaysArg.slice('--since-days='.length));
  if (sinceDays !== null && (!Number.isInteger(sinceDays) || sinceDays < 1)) {
    throw new Error('유효한 --since-days 값은 1 이상의 정수여야 합니다');
  }
  return {
    limit: Number.isInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : DEFAULT_LIMIT,
    sinceDays,
  };
}

export function mapPrecisionBackfillInput(row: PrecisionBackfillRow) {
  const listing = {
    caseNo: row.case_no,
    itemNo: row.item_no?.trim() || '1',
    court: row.court,
    address: row.address,
    propertyType: row.property_type,
    appraisalValue: numberOrZero(row.appraisal_value),
    minBidPrice: numberOrZero(row.min_bid_price),
    failCount: row.fail_count ?? 0,
    source: row.source,
    crawledAt: row.crawled_at instanceof Date ? row.crawled_at.toISOString() : row.crawled_at,
  } satisfies Listing;
  const rights = {
    classified: array(row.classified),
    tenants: array(row.tenants),
    assumedAmount: numberOrZero(row.assumed_amount),
    maxSafeBid: numberOrNull(row.max_safe_bid),
    redFlags: array(row.red_flags),
    riskGrade: riskGrade(row.risk_grade),
    warnings: array<string>(row.warnings),
  } as unknown as RightsAnalysisResult;
  const location = {
    marketPrice: numberOrNull(row.market_price),
    marketConfidence: row.market_confidence === 'high' || row.market_confidence === 'medium' || row.market_confidence === 'low'
      ? row.market_confidence
      : null,
    comps: array(row.comps),
    expectedBidPrice: numberOrNull(row.expected_bid_price),
    acquisitionCost: row.acquisition_cost ?? undefined,
    siteComps: array(row.site_comps),
    eviction: row.eviction ?? undefined,
  } as unknown as LocationAnalysis;

  return buildPrecisionInput({ listing, rights, location, trustStatus: trustStatus(row.trust_status) });
}

const record = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

export async function main(): Promise<void> {
  const { limit, sinceDays } = readPrecisionBackfillOptions();
  const rows = await query<PrecisionBackfillRow>(PRECISION_BACKFILL_SQL, [limit, sinceDays]);
  const statuses = new Map<string, number>();
  const reasons = new Map<string, number>();

  for (const row of rows) {
    const input = mapPrecisionBackfillInput(row);
    let evaluation = internalEvaluationHold();
    try {
      evaluation = evaluatePrecision(input);
    } catch (error) {
      console.warn(`[precision:backfill] ${row.case_no}/${row.item_no ?? '1'} 평가 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
    await savePrecisionEvaluation(row.id, evaluation, hashEvaluationInput(input));
    record(statuses, evaluation.status);
    evaluation.reasonCodes.forEach((reason) => record(reasons, reason));
  }

  const reasonSummary = [...reasons.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(', ') || 'none';
  console.log(`processed listings=${rows.length}`);
  console.log(`recommended=${statuses.get('recommended') ?? 0} conditional=${statuses.get('conditional') ?? 0} hold=${statuses.get('hold') ?? 0} rejected=${statuses.get('rejected') ?? 0}`);
  console.log(`top reasons: ${reasonSummary}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
