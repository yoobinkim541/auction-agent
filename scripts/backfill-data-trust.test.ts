import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LISTING_TRUST_SQL,
  OUTCOME_TRUST_SQL,
  isOutcomeTrustCandidate,
  mapListingTrustInput,
  mapOutcomeTrustInput,
  readTrustBackfillOptions,
} from './backfill-data-trust.ts';

describe('readTrustBackfillOptions', () => {
  it('gives --limit precedence over TRUST_BACKFILL_LIMIT', () => {
    const options = readTrustBackfillOptions(
      ['--limit=12', '--outcomes-only'],
      { TRUST_BACKFILL_LIMIT: '34' },
    );

    expect(options).toEqual({ limit: 12, outcomesOnly: true, sinceDays: null, force: false });
  });

  it('accepts a validated --since-days bound', () => {
    expect(readTrustBackfillOptions(['--since-days=2'], {})).toEqual({
      limit: 5000,
      outcomesOnly: false,
      sinceDays: 2,
      force: false,
    });
  });

  it.each(['0', '-1', '1.5', 'nope'])('rejects invalid --since-days=%s', (value) => {
    expect(() => readTrustBackfillOptions([`--since-days=${value}`], {}))
      .toThrow('유효한 --since-days');
  });
});

describe('trust backfill bounded selection', () => {
  it('bounds listings by crawl, analysis, and document update timestamps before limit', () => {
    expect(LISTING_TRUST_SQL).toContain('l.crawled_at');
    expect(LISTING_TRUST_SQL).toContain('r.analyzed_at');
    expect(LISTING_TRUST_SQL).toContain('loc.analyzed_at');
    expect(LISTING_TRUST_SQL).toContain('docs.updated_at');
    expect(LISTING_TRUST_SQL).toContain("make_interval(days => $2::int)");
    expect(LISTING_TRUST_SQL).toContain('$3::boolean');
    expect(LISTING_TRUST_SQL).toContain('r.analyzed_at as rights_analyzed_at');
    expect(LISTING_TRUST_SQL).toContain('loc.analyzed_at as location_analyzed_at');
    expect(LISTING_TRUST_SQL).not.toContain('greatest(r.analyzed_at, loc.analyzed_at) as analysis_at');
  });

  it('selects only missing or source-stale listing trust rows in since-days mode', () => {
    expect(LISTING_TRUST_SQL).toContain('left join gm_data_trust current_trust');
    expect(LISTING_TRUST_SQL).toContain('current_trust.evaluated_at is null');
    expect(LISTING_TRUST_SQL).toContain('current_trust.evaluated_at < greatest(');
    expect(LISTING_TRUST_SQL).toContain('$2::int is null');
  });

  it('bounds outcomes by their snapshot or result observation timestamp before limit', () => {
    expect(OUTCOME_TRUST_SQL).toContain('s.snapped_at');
    expect(OUTCOME_TRUST_SQL).toContain('max(observed.captured_at)');
    expect(OUTCOME_TRUST_SQL).toContain('observed_result.captured_at');
    expect(OUTCOME_TRUST_SQL).toContain("make_interval(days => $2::int)");
    expect(OUTCOME_TRUST_SQL).toContain('$3::boolean');
  });

  it('selects only missing or source-stale outcome trust rows in since-days mode', () => {
    expect(OUTCOME_TRUST_SQL).toContain('left join gm_outcome_trust current_trust');
    expect(OUTCOME_TRUST_SQL).toContain('current_trust.evaluated_at is null');
    expect(OUTCOME_TRUST_SQL).toContain('current_trust.evaluated_at < greatest(');
    expect(OUTCOME_TRUST_SQL).toContain('$2::int is null');
  });
});

describe('trust backfill mappings', () => {
  it('classifies matched-unsold snapshots instead of excluding them from outcome trust', () => {
    const source = readFileSync(new URL('./backfill-data-trust.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('and (not e.matched or e.sold)');
  });

  it('filters outcomes without a sale date before trust-key mapping', () => {
    const candidates = [{
      case_no: '2026타경0', item_no: '1', sale_date: null,
      appraisal_value: '100000000', sold_amount: null,
      sold: false, duplicate_result_count: 0, result_known: false, sale_date_matches: false, case_date_item_count: 0,
    }].filter(isOutcomeTrustCandidate);

    expect(candidates).toEqual([]);
  });

  it('maps listing analyses and documents into ListingTrustInput', () => {
    const input = mapListingTrustInput({
      id: 7,
      case_no: '2026타경1',
      item_no: ' 2 ',
      appraisal_value: '100000000',
      min_bid_price: '70000000',
      crawled_at: '2026-08-20T00:00:00.000Z',
      rights_analyzed: true,
      classified: [{ rank: 1 }, { rank: 2 }],
      tenants: [{ name: '임차인' }],
      warnings: ['금액 단위 확인 필요', '일반 경고'],
      location_analyzed: true,
      market_price: '120000000',
      expected_bid_price: '90000000',
      comps: [{ price: 1 }],
      site_comps: [{ price: 2 }, { price: 3 }],
      rights_analyzed_at: '2026-08-20T12:00:00.000Z',
      location_analyzed_at: '2026-08-21T00:00:00.000Z',
      documents: [{ itemNo: '3' }, { item_no: '2' }],
    });

    expect(input).toEqual({
      caseNo: '2026타경1', itemNo: '2', appraisalValue: 100000000, minBidPrice: 70000000,
      crawledAt: '2026-08-20T00:00:00.000Z', rightsAnalyzed: true, registryCount: 2, tenantCount: 1,
      moneyParseWarnings: 1, documentItemMismatch: true, locationAnalyzed: true,
      marketPrice: 120000000, expectedBidPrice: 90000000, comparableCount: 3,
      rightsAnalyzedAt: '2026-08-20T12:00:00.000Z',
      locationAnalyzedAt: '2026-08-21T00:00:00.000Z',
    });
  });

  it('marks a multi-item over-appraisal sale as batch-suspected', () => {
    const input = mapOutcomeTrustInput({
      case_no: '2026타경2', item_no: '4', sale_date: '2026-08-21',
      appraisal_value: '100000000', sold_amount: '160000000',
      sold: true, duplicate_result_count: 1, result_known: true, sale_date_matches: true, case_date_item_count: 2,
    });

    expect(input).toEqual({
      caseNo: '2026타경2', itemNo: '4', saleDate: '2026-08-21',
      appraisalValue: 100000000, soldAmount: 160000000, sold: true, duplicateResultCount: 1,
      resultKnown: true, saleDateMatches: true, batchSaleSuspected: true,
    });
  });
});
