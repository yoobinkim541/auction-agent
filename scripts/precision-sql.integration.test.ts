import 'dotenv/config';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { LISTING_TRUST_SQL, OUTCOME_TRUST_SQL } from './backfill-data-trust.ts';
import { PRECISION_BACKFILL_SQL } from './backfill-precision.ts';
import {
  PRECISION_AUDIT_SQL,
  auditResult,
  type PrecisionAuditMetrics,
} from './precision-audit.ts';

const describeDatabase = process.env.RUN_PRECISION_DB_TESTS === '1' ? describe : describe.skip;

async function createTemporaryRelations(client: Client): Promise<void> {
  await client.query(`
    create temp table gm_listings (
      id bigint primary key, case_no text, item_no text, court text, address text,
      property_type text, appraisal_value bigint, min_bid_price bigint, fail_count int,
      source text, sale_date date, crawled_at timestamptz
    ) on commit drop;
    create temp table gm_rights_analysis (
      id bigint, listing_id bigint, classified jsonb, tenants jsonb, warnings jsonb,
      assumed_amount bigint, max_safe_bid bigint, red_flags jsonb, risk_grade text,
      analyzed_at timestamptz
    ) on commit drop;
    create temp table gm_location_analysis (
      id bigint, listing_id bigint, market_price bigint, expected_bid_price bigint,
      comps jsonb, site_comps jsonb, market_confidence text, acquisition_cost jsonb,
      eviction jsonb, analyzed_at timestamptz
    ) on commit drop;
    create temp table gm_listing_docs (
      listing_id bigint, parsed_json jsonb, created_at timestamptz
    ) on commit drop;
    create temp table gm_data_trust (
      listing_id bigint, status text, reason_codes jsonb, evaluated_at timestamptz
    ) on commit drop;
    create temp table gm_precision_evaluations (
      listing_id bigint, status text, confidence text, hard_cap_bid bigint,
      reason_codes jsonb, evaluated_at timestamptz
    ) on commit drop;
    create temp table gm_precision_shortlist (listing_id bigint, case_no text) on commit drop;
    create temp table gm_outcome_eval (
      case_no text, item_no text, sale_date date, appraisal_value bigint,
      sold_amount bigint, matched boolean
    ) on commit drop;
    create temp table gm_prediction_snapshots (
      case_no text, item_no text, sale_date date, snapped_at timestamptz
    ) on commit drop;
    create temp table gm_auction_results (
      case_no text, item_no text, dxdy_date date, captured_at timestamptz
    ) on commit drop;
    create temp table gm_outcome_trust (
      case_no text, item_no text, sale_date date, status text,
      reason_codes jsonb, evaluated_at timestamptz
    ) on commit drop;
    create temp table gm_current_decisions (listing_id bigint, decision text) on commit drop;
  `);
}

async function withTemporaryDatabase(run: (client: Client) => Promise<void>): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('RUN_PRECISION_DB_TESTS=1 requires DATABASE_URL');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('begin');
    await client.query('set local search_path to pg_temp, public');
    await createTemporaryRelations(client);
    await run(client);
  } finally {
    await client.query('rollback').catch(() => undefined);
    await client.end();
  }
}

const ids = (rows: Array<{ id: string | number }>): number[] => rows.map(({ id }) => Number(id));

describeDatabase('precision production SQL against temporary PostgreSQL fixtures', () => {
  it('returns exact audit metrics for every safety invariant and report distribution', async () => {
    await withTemporaryDatabase(async (client) => {
      await client.query(`
        insert into gm_listings
          (id, case_no, item_no, court, address, property_type, appraisal_value,
           min_bid_price, fail_count, source, sale_date, crawled_at)
        select id, 'case-' || id, '1', 'court', 'address', 'apartment', 200, 100,
               0, 'courtauction', current_date + 1, now()
          from generate_series(1, 13) id;
        insert into gm_precision_evaluations
          (listing_id, status, confidence, hard_cap_bid, reason_codes, evaluated_at)
        select id,
               case when id <= 10 then 'recommended' when id = 11 then 'hold'
                    when id = 12 then 'conditional' else 'rejected' end,
               'high', case when id = 6 then null when id = 7 then 90 else 120 end,
               case when id = 11 then '["PRECISION_HOLD"]'::jsonb else '[]'::jsonb end,
               now()
          from generate_series(1, 13) id;
        insert into gm_data_trust (listing_id, status, reason_codes, evaluated_at)
        select id, case when id = 1 then 'hold' else 'trusted' end,
               case when id = 1 then '["LISTING_HOLD"]'::jsonb else '[]'::jsonb end,
               now()
          from generate_series(1, 13) id where id <> 2;
        insert into gm_rights_analysis
          (id, listing_id, classified, tenants, warnings, assumed_amount, max_safe_bid,
           red_flags, risk_grade, analyzed_at)
        select id, id, '[]', '[]', '[]',
               case when id = 3 then 50 when id = 5 then null else 0 end,
               120, '[]', 'clean', now()
          from generate_series(1, 13) id where id <> 4;
        insert into gm_precision_shortlist values
          (1, 'duplicate-case'), (2, 'duplicate-case'), (3, 'case-3'), (4, 'case-4'),
          (5, 'case-5'), (6, 'case-6'), (7, 'case-7'), (8, 'case-8');
        insert into gm_current_decisions values
          (1, 'reviewing'), (2, 'reviewing'), (3, 'rejected'), (4, 'favorite');
        insert into gm_outcome_eval values
          ('outcome-1', '1', current_date - 1, 200, 150, true),
          ('outcome-2', '1', current_date - 1, 200, null, true),
          ('outcome-3', '1', current_date - 1, 200, 500, false),
          ('outcome-4', '1', current_date - 1, 200, 160, true);
        insert into gm_outcome_trust values
          ('outcome-1', '1', current_date - 1, 'trusted', '[]', now()),
          ('outcome-2', '1', current_date - 1, 'hold', '["OUTCOME_HOLD"]', now()),
          ('outcome-3', '1', current_date - 1, 'quarantined', '["OUTCOME_QUAR"]', now());
      `);

      const metrics = (await client.query<{ metrics: PrecisionAuditMetrics }>(PRECISION_AUDIT_SQL)).rows[0]!.metrics;
      expect(metrics.safety).toEqual({
        recommendedNonTrusted: 2,
        recommendedAssumedAmount: 3,
        recommendedHardCapBelowMinBid: 2,
        duplicateCaseRepresentatives: 1,
        shortlistCount: 8,
      });
      expect(metrics.precisionStatusDistribution).toEqual([
        { status: 'conditional', count: 1 }, { status: 'hold', count: 1 },
        { status: 'recommended', count: 10 }, { status: 'rejected', count: 1 },
      ]);
      expect(metrics.listingTrustStatusDistribution).toEqual([
        { status: 'hold', count: 1 }, { status: 'trusted', count: 11 },
      ]);
      expect(metrics.outcomeTrustStatusDistribution).toEqual([
        { status: 'hold', count: 1 }, { status: 'quarantined', count: 1 },
        { status: 'trusted', count: 1 },
      ]);
      expect(metrics.topHoldQuarantineReasons).toEqual([
        { scope: 'listing_trust', status: 'hold', reason: 'LISTING_HOLD', count: 1 },
        { scope: 'outcome_trust', status: 'hold', reason: 'OUTCOME_HOLD', count: 1 },
        { scope: 'outcome_trust', status: 'quarantined', reason: 'OUTCOME_QUAR', count: 1 },
        { scope: 'precision', status: 'hold', reason: 'PRECISION_HOLD', count: 1 },
      ]);
      expect(metrics.decisionConversion).toEqual({
        recommended: 8, decided: 4, conversionRate: 0.5,
        byDecision: { favorite: 1, rejected: 1, reviewing: 2 },
      });
      expect(metrics.trustedOutcomeCoverage).toEqual({
        raw: 4, evaluated: 3, trusted: 1, hold: 1, quarantined: 1, trustedRate: 0.25,
      });
      expect(auditResult(metrics).failures.map(({ code }) => code)).toEqual([
        'RECOMMENDED_NON_TRUSTED', 'RECOMMENDED_ASSUMED_AMOUNT',
        'RECOMMENDED_HARD_CAP_BELOW_MIN_BID', 'DUPLICATE_CASE_REPRESENTATIVES',
        'SHORTLIST_ABOVE_WEEKLY_CAP',
      ]);
    });
  });

  it('returns a clean zero-recommendation audit with warning only', async () => {
    await withTemporaryDatabase(async (client) => {
      const metrics = (await client.query<{ metrics: PrecisionAuditMetrics }>(PRECISION_AUDIT_SQL)).rows[0]!.metrics;
      expect(metrics).toEqual({
        safety: {
          recommendedNonTrusted: 0, recommendedAssumedAmount: 0,
          recommendedHardCapBelowMinBid: 0, duplicateCaseRepresentatives: 0,
          shortlistCount: 0,
        },
        precisionStatusDistribution: [], listingTrustStatusDistribution: [],
        outcomeTrustStatusDistribution: [], topHoldQuarantineReasons: [],
        decisionConversion: { recommended: 0, decided: 0, conversionRate: 0, byDecision: {} },
        trustedOutcomeCoverage: {
          raw: 0, evaluated: 0, trusted: 0, hold: 0, quarantined: 0, trustedRate: 0,
        },
      });
      expect(auditResult(metrics)).toMatchObject({
        ok: true, failures: [], warnings: [{ code: 'ZERO_RECOMMENDATIONS' }],
      });
    });
  });

  it('drains listing trust rows without document multiplication or reevaluating newer rows', async () => {
    await withTemporaryDatabase(async (client) => {
      await client.query(`
        insert into gm_listings values
          (1, 'case-1', '1', 'court', 'address-1', 'apartment', 200, 100, 0, 'courtauction', current_date + 1, now() - interval '10 minutes'),
          (2, 'case-2', '1', 'court', 'address-2', 'apartment', 200, 100, 0, 'courtauction', current_date + 1, now() - interval '20 minutes'),
          (3, 'case-3', '1', 'court', 'address-3', 'apartment', 200, 100, 0, 'courtauction', current_date + 1, now() - interval '30 minutes');
        insert into gm_rights_analysis values
          (1, 1, '[]', '[]', '[]', 0, 120, '[]', 'clean', now() - interval '12 minutes'),
          (2, 2, '[]', '[]', '[]', 0, 120, '[]', 'clean', now() - interval '15 minutes'),
          (3, 3, '[]', '[]', '[]', 0, 120, '[]', 'clean', now() - interval '20 minutes');
        insert into gm_location_analysis values
          (1, 1, 220, 130, '[]', '[]', 'high', '{}', '{}', now() - interval '11 minutes'),
          (2, 2, 220, 130, '[]', '[]', 'high', '{}', '{}', now() - interval '18 minutes'),
          (3, 3, 220, 130, '[]', '[]', 'high', '{}', '{}', now() - interval '10 minutes');
        insert into gm_listing_docs values
          (1, '{"doc":1}', now() - interval '6 minutes'),
          (1, '{"doc":2}', now() - interval '5 minutes');
        insert into gm_data_trust values
          (2, 'hold', '[]', now() - interval '1 hour'),
          (3, 'trusted', '[]', now());
      `);

      const bounded = await client.query<{ id: string | number; documents: unknown[] }>(LISTING_TRUST_SQL, [10, 2]);
      expect(ids(bounded.rows)).toEqual([1, 2]);
      expect(bounded.rows[0]!.documents).toHaveLength(2);
      expect((await client.query(LISTING_TRUST_SQL, [1, 2])).rows).toHaveLength(1);
      await client.query("insert into gm_data_trust values (1, 'trusted', '[]', now())");
      expect(ids((await client.query<{ id: string | number }>(LISTING_TRUST_SQL, [1, 2])).rows)).toEqual([2]);
      expect(new Set(ids((await client.query<{ id: string | number }>(LISTING_TRUST_SQL, [10, null])).rows)))
        .toEqual(new Set([1, 2, 3]));
    });
  });

  it('drains outcome rows by exact case, item, and date without duplication', async () => {
    await withTemporaryDatabase(async (client) => {
      await client.query(`
        insert into gm_outcome_eval values
          ('case-a', '1', current_date - 1, 200, 151, true),
          ('case-a', '2', current_date - 1, 300, 252, true),
          ('case-b', '1', current_date - 1, 400, 353, true);
        insert into gm_prediction_snapshots values
          ('case-a', '1', current_date - 1, now() - interval '5 minutes'),
          ('case-a', '2', current_date - 1, now() - interval '10 minutes'),
          ('case-b', '1', current_date - 1, now() - interval '15 minutes');
        insert into gm_auction_results values
          ('case-a', '1', current_date - 1, now() - interval '4 minutes'),
          ('case-a', '1', current_date - 1, now() - interval '3 minutes'),
          ('case-a', '1', current_date - 2, now() - interval '1 minute'),
          ('case-a', '2', current_date - 1, now() - interval '9 minutes'),
          ('case-b', '1', current_date - 1, now() - interval '14 minutes');
        insert into gm_outcome_trust values
          ('case-a', '2', current_date - 1, 'trusted', '[]', now()),
          ('case-b', '1', current_date - 1, 'hold', '[]', now() - interval '1 hour');
      `);

      const bounded = await client.query<{
        case_no: string; item_no: string; sold_amount: string | number;
        duplicate_result_count: string | number; case_date_item_count: string | number;
      }>(OUTCOME_TRUST_SQL, [10, 2]);
      expect(bounded.rows.map(({ case_no, item_no }) => `${case_no}/${item_no}`)).toEqual(['case-a/1', 'case-b/1']);
      expect(Number(bounded.rows[0]!.sold_amount)).toBe(151);
      expect(Number(bounded.rows[0]!.duplicate_result_count)).toBe(2);
      expect(Number(bounded.rows[0]!.case_date_item_count)).toBe(2);
      const first = (await client.query<{ case_no: string; item_no: string; sale_date: Date }>(OUTCOME_TRUST_SQL, [1, 2])).rows[0]!;
      await client.query(
        `insert into gm_outcome_trust values ($1, $2, $3, 'trusted', '[]', now())`,
        [first.case_no, first.item_no, first.sale_date],
      );
      const next = (await client.query<{ case_no: string; item_no: string }>(OUTCOME_TRUST_SQL, [1, 2])).rows[0]!;
      expect(`${next.case_no}/${next.item_no}`).toBe('case-b/1');
    });
  });

  it('drains precision rows while skipping evaluations newer than all source inputs', async () => {
    await withTemporaryDatabase(async (client) => {
      await client.query(`
        insert into gm_listings values
          (1, 'case-1', '1', 'court', 'address-1', 'apartment', 200, 100, 0, 'courtauction', current_date + 1, now() - interval '20 minutes'),
          (2, 'case-2', '1', 'court', 'address-2', 'apartment', 200, 100, 0, 'courtauction', current_date + 1, now() - interval '20 minutes'),
          (3, 'case-3', '1', 'court', 'address-3', 'apartment', 200, 100, 0, 'courtauction', current_date + 1, now() - interval '20 minutes');
        insert into gm_rights_analysis values
          (1, 1, '[]', '[]', '[]', 0, 120, '[]', 'clean', now() - interval '20 minutes'),
          (2, 2, '[]', '[]', '[]', 0, 120, '[]', 'clean', now() - interval '20 minutes'),
          (3, 3, '[]', '[]', '[]', 0, 120, '[]', 'clean', now() - interval '20 minutes');
        insert into gm_location_analysis values
          (1, 1, 220, 130, '[]', '[]', 'high', '{}', '{}', now() - interval '20 minutes'),
          (2, 2, 220, 130, '[]', '[]', 'high', '{}', '{}', now() - interval '20 minutes'),
          (3, 3, 220, 130, '[]', '[]', 'high', '{}', '{}', now() - interval '20 minutes');
        insert into gm_data_trust values
          (1, 'trusted', '[]', now() - interval '5 minutes'),
          (2, 'trusted', '[]', now() - interval '10 minutes'),
          (3, 'trusted', '[]', now() - interval '15 minutes');
        insert into gm_precision_evaluations values
          (2, 'hold', 'low', null, '[]', now() - interval '1 hour'),
          (3, 'hold', 'low', null, '[]', now());
      `);

      expect(ids((await client.query<{ id: string | number }>(PRECISION_BACKFILL_SQL, [10, 2])).rows)).toEqual([1, 2]);
      await client.query("insert into gm_precision_evaluations values (1, 'hold', 'low', null, '[]', now())");
      expect(ids((await client.query<{ id: string | number }>(PRECISION_BACKFILL_SQL, [1, 2])).rows)).toEqual([2]);
    });
  });
});
