import 'dotenv/config';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { saveListingDataTrust, saveOutcomeTrust, query } from '../shared/db.ts';
import { evaluateListingTrust } from '../shared/data-trust.ts';
import type { ListingTrustInput } from '../shared/data-trust.ts';
import { evaluateOutcomeTrust } from '../shared/outcome-trust.ts';
import type { OutcomeTrustInput } from '../shared/outcome-trust.ts';

const DEFAULT_LIMIT = 5000;
const MONEY_WARNING_PATTERNS = ['파싱', '금액 단위', '보증금 단위'];

export interface TrustBackfillOptions {
  limit: number;
  outcomesOnly: boolean;
}

export interface ListingTrustBackfillRow {
  id: number;
  case_no: string;
  item_no: string | null;
  appraisal_value: string | number | null;
  min_bid_price: string | number | null;
  crawled_at: string | Date;
  rights_analyzed: boolean;
  classified: unknown;
  tenants: unknown;
  warnings: unknown;
  location_analyzed: boolean;
  market_price: string | number | null;
  expected_bid_price: string | number | null;
  comps: unknown;
  site_comps: unknown;
  analysis_at: string | Date | null;
  documents: unknown;
}

export interface OutcomeTrustBackfillRow {
  case_no: string;
  item_no: string | null;
  sale_date: string | Date | null;
  appraisal_value: string | number | null;
  sold_amount: string | number | null;
  duplicate_result_count: string | number;
  sale_date_matches: boolean;
  case_date_item_count: string | number;
}

const numberOrNull = (value: string | number | null): number | null => {
  if (value === null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const normalizedItemNo = (value: string | null): string => value?.trim() || '1';

const timestamp = (value: string | Date | null): string | null => {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
};

const saleDate = (value: string | Date): string => (
  value instanceof Date ? value.toISOString().slice(0, 10) : value
);

const arrayLength = (value: unknown): number => Array.isArray(value) ? value.length : 0;

const isNonblank = (value: unknown): boolean => value != null && String(value).trim().length > 0;

const documentItemMismatch = (documents: unknown, itemNo: string): boolean => (
  Array.isArray(documents) && documents.some((document) => {
    if (document === null || typeof document !== 'object') return false;
    const parsed = document as Record<string, unknown>;
    return [parsed.itemNo, parsed.item_no].some((value) => isNonblank(value) && String(value).trim() !== itemNo);
  })
);

const moneyParseWarnings = (warnings: unknown): number => (
  Array.isArray(warnings)
    ? warnings.filter((warning) => MONEY_WARNING_PATTERNS.some((pattern) => String(warning).includes(pattern))).length
    : 0
);

export function readTrustBackfillOptions(
  args: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env,
): TrustBackfillOptions {
  const cliLimit = args.find((arg) => arg.startsWith('--limit='));
  const rawLimit = cliLimit === undefined ? env.TRUST_BACKFILL_LIMIT : cliLimit.slice('--limit='.length);
  const parsedLimit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);

  return {
    limit: Number.isInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : DEFAULT_LIMIT,
    outcomesOnly: args.includes('--outcomes-only'),
  };
}

export function mapListingTrustInput(row: ListingTrustBackfillRow): ListingTrustInput {
  const itemNo = normalizedItemNo(row.item_no);
  return {
    caseNo: row.case_no,
    itemNo,
    appraisalValue: numberOrNull(row.appraisal_value),
    minBidPrice: numberOrNull(row.min_bid_price),
    crawledAt: timestamp(row.crawled_at)!,
    rightsAnalyzed: row.rights_analyzed,
    registryCount: arrayLength(row.classified),
    tenantCount: arrayLength(row.tenants),
    moneyParseWarnings: moneyParseWarnings(row.warnings),
    documentItemMismatch: documentItemMismatch(row.documents, itemNo),
    locationAnalyzed: row.location_analyzed,
    marketPrice: numberOrNull(row.market_price),
    expectedBidPrice: numberOrNull(row.expected_bid_price),
    comparableCount: arrayLength(row.comps) + arrayLength(row.site_comps),
    analysisAt: timestamp(row.analysis_at),
  };
}

export function isOutcomeTrustCandidate(
  row: OutcomeTrustBackfillRow,
): row is OutcomeTrustBackfillRow & { sale_date: string | Date } {
  return row.sale_date !== null;
}

export function mapOutcomeTrustInput(
  row: OutcomeTrustBackfillRow & { sale_date: string | Date },
): OutcomeTrustInput {
  const appraisalValue = numberOrNull(row.appraisal_value);
  const soldAmount = numberOrNull(row.sold_amount);
  return {
    caseNo: row.case_no,
    itemNo: normalizedItemNo(row.item_no),
    saleDate: saleDate(row.sale_date),
    appraisalValue,
    soldAmount,
    duplicateResultCount: Number(row.duplicate_result_count),
    saleDateMatches: row.sale_date_matches,
    batchSaleSuspected: Number(row.case_date_item_count) > 1
      && appraisalValue !== null
      && soldAmount !== null
      && soldAmount > appraisalValue * 1.5,
  };
}

const LISTING_TRUST_SQL = `
  select l.id, l.case_no, l.item_no, l.appraisal_value, l.min_bid_price, l.crawled_at,
         (r.id is not null) as rights_analyzed, r.classified, r.tenants, r.warnings,
         (loc.id is not null) as location_analyzed, loc.market_price, loc.expected_bid_price,
         loc.comps, loc.site_comps, greatest(r.analyzed_at, loc.analyzed_at) as analysis_at,
         docs.documents
    from gm_listings l
    left join gm_rights_analysis r on r.listing_id = l.id
    left join gm_location_analysis loc on loc.listing_id = l.id
    left join lateral (
      select coalesce(jsonb_agg(d.parsed_json), '[]'::jsonb) as documents
        from gm_listing_docs d
       where d.listing_id = l.id
    ) docs on true
   order by l.crawled_at desc, l.id desc
   limit $1`;

const OUTCOME_TRUST_SQL = `
  select e.case_no, e.item_no, e.sale_date, e.appraisal_value, e.sold_amount,
         (select count(*) from gm_auction_results r
           where r.case_no = e.case_no
             and coalesce(nullif(r.item_no, ''), '1') = coalesce(nullif(e.item_no, ''), '1')
             and r.dxdy_date = e.sale_date) as duplicate_result_count,
         e.matched as sale_date_matches,
         (select count(distinct coalesce(nullif(r.item_no, ''), '1')) from gm_auction_results r
           where r.case_no = e.case_no and r.dxdy_date = e.sale_date) as case_date_item_count
    from gm_outcome_eval e
   where e.sale_date is not null
     and (not e.matched or e.sold)
   order by e.sale_date desc, e.case_no, e.item_no
   limit $1`;

type Status = 'trusted' | 'hold' | 'quarantined';

const record = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

const inputHash = (input: ListingTrustInput): string => (
  createHash('sha256').update(JSON.stringify(input)).digest('hex')
);

async function backfillListings(limit: number, statuses: Map<string, number>, reasons: Map<string, number>): Promise<number> {
  const rows = await query<ListingTrustBackfillRow>(LISTING_TRUST_SQL, [limit]);
  for (const row of rows) {
    const input = mapListingTrustInput(row);
    const result = evaluateListingTrust(input);
    await saveListingDataTrust(row.id, result, inputHash(input));
    record(statuses, result.status);
    result.reasonCodes.forEach((reason) => record(reasons, reason));
  }
  return rows.length;
}

async function backfillOutcomes(limit: number, statuses: Map<string, number>, reasons: Map<string, number>): Promise<number> {
  const rows = await query<OutcomeTrustBackfillRow>(OUTCOME_TRUST_SQL, [limit]);
  for (const row of rows.filter(isOutcomeTrustCandidate)) {
    const input = mapOutcomeTrustInput(row);
    const result = evaluateOutcomeTrust(input);
    await saveOutcomeTrust(input.caseNo!, input.itemNo!, input.saleDate!, result);
    record(statuses, result.status);
    result.reasonCodes.forEach((reason) => record(reasons, reason));
  }
  return rows.length;
}

export async function main(): Promise<void> {
  const options = readTrustBackfillOptions();
  const statuses = new Map<Status, number>([['trusted', 0], ['hold', 0], ['quarantined', 0]]);
  const reasons = new Map<string, number>();
  const listings = options.outcomesOnly ? 0 : await backfillListings(options.limit, statuses, reasons);
  const outcomes = await backfillOutcomes(options.limit, statuses, reasons);
  const reasonSummary = [...reasons.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(', ') || 'none';

  console.log(`processed listings=${listings} outcomes=${outcomes}`);
  console.log(`trusted=${statuses.get('trusted') ?? 0} hold=${statuses.get('hold') ?? 0} quarantined=${statuses.get('quarantined') ?? 0}`);
  console.log(`top reasons: ${reasonSummary}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
