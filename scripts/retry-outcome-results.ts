/**
 * Phase2 결과 retry worker — gm_result_retry_queue의 미매칭 스냅샷을 bounded batch로 재수집한다.
 * 사용: npm run retry:outcomes
 * 옵션: OUTCOME_RETRY_LIMIT=50 OUTCOME_RETRY_COOLDOWN_HOURS=24 OUTCOME_RETRY_DRY_RUN=true
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import {
  collectCaseResults,
  collectSaleResults,
  courtCodeByName,
  failedRoundCount,
  nextSaleDate,
  type SaleResultRound,
} from '../crawler/adapters/courtauction.ts';
import {
  emptyRetryCounters,
  statusFromRounds,
  toCourtCaseNo,
  toCourtItemNo,
} from './outcome-retry-utils.ts';

interface RetryQueueRow {
  case_no: string;
  item_no: string;
  sale_date: string;
  court: string;
  retry_priority: number;
  retry_attempts: number;
  retry_last_status: string | null;
}

interface CourtCase {
  caseNo: string;
  cortOfcCd: string;
  itemNo: string;
}

function todayKst(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function httpStatusFromError(err: unknown): number | null {
  const message = errorMessage(err);
  const match = message.match(/HTTP\s+(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function isBlockedError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'CourtAuctionBlockedError') return true;
  return /ipcheck|blocked|captcha|차단/i.test(errorMessage(err));
}

async function recordRounds(caseNo: string, itemNo: string, court: string | null, rounds: SaleResultRound[], today: string): Promise<number> {
  let upserted = 0;
  for (const round of rounds) {
    await query(
      `insert into gm_auction_results (case_no,item_no,court,dxdy_date,kind_cd,result_cd,min_price,sold_amount,sold,captured_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       on conflict (case_no,item_no,dxdy_date) do update set
         kind_cd=excluded.kind_cd, result_cd=excluded.result_cd, min_price=excluded.min_price,
         sold_amount=excluded.sold_amount, sold=excluded.sold, captured_at=now()`,
      [caseNo, itemNo, court, round.date, round.kindCd, round.resultCd, round.minPrice, round.soldAmount, round.sold],
    );
    upserted++;
  }
  const next = nextSaleDate(rounds, today);
  if (next) {
    await query(
      `update gm_listings set sale_date=$1::date, min_bid_price=coalesce($2, min_bid_price), fail_count=$3
         where case_no=$4 and coalesce(nullif(item_no,''),'1')=$5 and sale_date is distinct from $1::date`,
      [next.date, next.minPrice, failedRoundCount(rounds, today), caseNo, itemNo],
    );
  }
  return upserted;
}

async function upsertRetryStatus(row: RetryQueueRow, patch: {
  status: 'success' | 'empty' | 'blocked' | 'error';
  phase: string;
  error?: string | null;
  httpStatus?: number | null;
  captchaDetected?: boolean;
  blockedReason?: string | null;
  roundCount?: number;
}): Promise<void> {
  await query(
    `insert into gm_result_retry_status
       (case_no, item_no, sale_date, attempts, last_status, last_phase, last_error, last_http_status,
        captcha_detected, blocked_reason, last_round_count, last_attempted_at, succeeded_at)
     values ($1,$2,$3::date,1,$4,$5,$6,$7,$8,$9,$10,now(),case when $4='success' then now() else null end)
     on conflict (case_no, item_no, sale_date) do update set
       attempts = gm_result_retry_status.attempts + 1,
       last_status = excluded.last_status,
       last_phase = excluded.last_phase,
       last_error = excluded.last_error,
       last_http_status = excluded.last_http_status,
       captcha_detected = excluded.captcha_detected,
       blocked_reason = excluded.blocked_reason,
       last_round_count = excluded.last_round_count,
       last_attempted_at = now(),
       succeeded_at = case when excluded.last_status='success' then now() else gm_result_retry_status.succeeded_at end`,
    [
      row.case_no,
      toCourtItemNo(row.item_no),
      row.sale_date,
      patch.status,
      patch.phase,
      patch.error ?? null,
      patch.httpStatus ?? null,
      patch.captchaDetected ?? false,
      patch.blockedReason ?? null,
      patch.roundCount ?? 0,
    ],
  );
}

async function fetchTargets(limit: number, cooldownHours: number): Promise<RetryQueueRow[]> {
  return query<RetryQueueRow>(
    `select e.case_no, coalesce(nullif(e.item_no,''),'1') as item_no, e.sale_date::text, e.court,
            coalesce(rs.attempts, 0) as retry_attempts,
            rs.last_status as retry_last_status,
            case
              when e.sale_date < current_date - 14 then 100
              when e.passed_filter then 80
              when e.total_score >= 70 then 70
              else 50
            end as retry_priority
       from gm_outcome_eval e
       left join gm_result_retry_status rs
         on rs.case_no = e.case_no
        and rs.item_no = coalesce(nullif(e.item_no,''),'1')
        and rs.sale_date = e.sale_date
      where e.sale_date < current_date
        and e.matched = false
        and coalesce(rs.last_status, 'pending') <> 'success'
        and (rs.last_attempted_at is null or rs.last_attempted_at < now() - make_interval(hours => $2::int))
      order by retry_priority desc, e.sale_date desc, e.case_no, item_no
      limit $1`,
    [limit, cooldownHours],
  );
}

async function collectOne(row: RetryQueueRow, courtCase: CourtCase, today: string): Promise<{ phase: string; rounds: SaleResultRound[] }> {
  const active = await collectSaleResults([courtCase]);
  const activeRounds = active.get(`${courtCase.caseNo}|${courtCase.itemNo}`) ?? [];
  if (activeRounds.length > 0) return { phase: 'active_detail', rounds: activeRounds };
  const closed = await collectCaseResults([courtCase]);
  return { phase: 'closed_case', rounds: closed.get(`${courtCase.caseNo}|${courtCase.itemNo}`) ?? [] };
}

async function main(): Promise<void> {
  const limit = Math.max(1, Math.min(500, Number(process.env.OUTCOME_RETRY_LIMIT) || 50));
  const cooldownHours = Math.max(0, Math.min(24 * 30, Number(process.env.OUTCOME_RETRY_COOLDOWN_HOURS) || 24));
  const dryRun = process.env.OUTCOME_RETRY_DRY_RUN === 'true';
  const today = todayKst();
  const counters = emptyRetryCounters();
  const targets = await fetchTargets(limit, cooldownHours);
  console.log(`[retry-outcomes] 대상 ${targets.length}건(limit=${limit}, cooldown=${cooldownHours}h, dryRun=${dryRun ? 'true' : 'false'})`);

  if (dryRun) {
    for (const row of targets) console.log(`[retry-outcomes] dry-run ${row.case_no}#${row.item_no} sale=${row.sale_date} court=${row.court} priority=${row.retry_priority}`);
    await pool().end();
    return;
  }

  for (const row of targets) {
    counters.processed++;
    const cortOfcCd = courtCodeByName(row.court);
    if (!cortOfcCd) {
      counters.skipped++;
      await upsertRetryStatus(row, { status: 'error', phase: 'preflight', error: `법원코드 미매핑: ${row.court}` });
      continue;
    }
    const courtCase = { caseNo: toCourtCaseNo(row.case_no), itemNo: toCourtItemNo(row.item_no), cortOfcCd };
    try {
      const result = await collectOne(row, courtCase, today);
      const status = statusFromRounds(result.rounds);
      if (status === 'success') {
        await recordRounds(row.case_no, toCourtItemNo(row.item_no), row.court, result.rounds, today);
        counters.success++;
      } else {
        counters.empty++;
      }
      await upsertRetryStatus(row, { status, phase: result.phase, roundCount: result.rounds.length });
      console.log(`[retry-outcomes] ${status} ${row.case_no}#${row.item_no} phase=${result.phase} rounds=${result.rounds.length}`);
    } catch (err) {
      const message = errorMessage(err);
      if (isBlockedError(err)) {
        counters.blocked++;
        await upsertRetryStatus(row, {
          status: 'blocked',
          phase: 'collect',
          error: message,
          httpStatus: httpStatusFromError(err),
          captchaDetected: true,
          blockedReason: message,
        });
        console.error(`[retry-outcomes] blocked ${row.case_no}#${row.item_no}: ${message}`);
        break;
      }
      counters.error++;
      await upsertRetryStatus(row, { status: 'error', phase: 'collect', error: message, httpStatus: httpStatusFromError(err) });
      console.error(`[retry-outcomes] error ${row.case_no}#${row.item_no}: ${message}`);
    }
  }

  console.log(`[retry-outcomes] 처리 ${counters.processed} · 성공 ${counters.success} · 빈결과 ${counters.empty} · 차단 ${counters.blocked} · 오류 ${counters.error} · 스킵 ${counters.skipped}`);
  await pool().end();
}

main().catch(async (err) => {
  console.error('retry-outcomes 실패:', errorMessage(err));
  await pool().end().catch(() => {});
  process.exitCode = 1;
});
