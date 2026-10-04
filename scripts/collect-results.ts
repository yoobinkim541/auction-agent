/**
 * 결과 수집(학습) — 법원경매 사건 결과(낙찰가·유찰·차기기일)를 gm_auction_results에 적재 + 유찰분 sale_date 백필.
 *  1차(활성/예정): 진행물건 상세(pgj15B) gdsDspslDxdyLst — 유찰이력·진행 차기기일.
 *  2차(과거/종결 소급): 경매사건검색(pgj15A) — 종결 후에도 낙찰가·결과(현 D+ 등 미수집분). docs/courtauction-result-endpoint.md.
 * 매각된 사건은 진행물건 상세에서 곧 사라지므로 매일 폴링 + 2차 소급으로 보완. (응찰자수 미제공 — 관심수 proxy.)
 * 3차(Phase2): gm_outcome_eval 미매칭 스냅샷을 직접 겨냥해 복기 데이터 missRate를 낮춘다.
 *             진행물건 상세를 먼저 보고, 종결/미노출 사건은 경매사건검색으로 보완한다.
 * 사용: npm run collect:results   (RESULT_DAYS_BACK 5 · RESULT_DAYS_FWD 21 · RESULT_LIMIT 300 · RESULT_BACKFILL_LIMIT 60 · RESULT_EVAL_BACKFILL_LIMIT 300)
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import {
  collectSaleResults, collectCaseResults, courtCodeByName,
  nextSaleDate, failedRoundCount, type SaleResultRound,
} from '../crawler/adapters/courtauction.ts';
import { normalizeCaseNo } from '../crawler/normalize.ts';

interface Counters { upserted: number; sold: number; refreshed: number }
interface DbKey { caseNo: string; itemNo: string }
interface PhaseTracker { failures: string[] }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runPhase<T>(label: string, tracker: PhaseTracker, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = errorMessage(err);
    tracker.failures.push(`${label}: ${message}`);
    console.error(`[collect-results] ⚠️ ${label} 실패 — 다음 단계 계속 진행: ${message}`);
    return fallback;
  }
}

function toCourtCaseNo(caseNo: string): string {
  const normalized = normalizeCaseNo(caseNo);
  const m = normalized.match(/^(20\d\d)-(\d+)$/);
  return m ? `${m[1]}타경${m[2]}` : normalized;
}

function toCourtItemNo(itemNo: string | null | undefined): string {
  const n = parseInt(String(itemNo ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '1';
}

/** 회차 결과 upsert + 유찰 차기기일 sale_date 백필(변경 있을 때만). 1·2차 공용. */
async function recordRounds(caseNo: string, itemNo: string, court: string | null, rounds: SaleResultRound[], today: string, ctr: Counters): Promise<void> {
  for (const rd of rounds) {
    await query(
      `insert into gm_auction_results (case_no,item_no,court,dxdy_date,kind_cd,result_cd,min_price,sold_amount,sold,captured_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       on conflict (case_no,item_no,dxdy_date) do update set
         kind_cd=excluded.kind_cd, result_cd=excluded.result_cd, min_price=excluded.min_price,
         sold_amount=excluded.sold_amount, sold=excluded.sold, captured_at=now()`,
      [caseNo, itemNo, court, rd.date, rd.kindCd, rd.resultCd, rd.minPrice, rd.soldAmount, rd.sold],
    );
    ctr.upserted++;
    if (rd.sold) ctr.sold++;
  }
  const next = nextSaleDate(rounds, today);
  if (next) {
    const res = await query(
      `update gm_listings set sale_date=$1::date, min_bid_price=coalesce($2, min_bid_price), fail_count=$3
         where case_no=$4 and coalesce(nullif(item_no,''),'1')=$5 and sale_date is distinct from $1::date
       returning case_no`,
      [next.date, next.minPrice, failedRoundCount(rounds, today), caseNo, itemNo],
    );
    if (res.length) ctr.refreshed++;
  }
}

async function main(): Promise<void> {
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // KST
  type Row = { case_no: string; item_no: string; court: string; sale_date: string };
  const toCases = (rows: Row[]) => {
    const courtOf = new Map<string, string>();
    const dbKeyOf = new Map<string, DbKey>();
    const cases = rows.map((r) => {
      const caseNo = toCourtCaseNo(r.case_no);
      const itemNo = toCourtItemNo(r.item_no);
      const key = `${caseNo}|${itemNo}`;
      courtOf.set(key, r.court);
      dbKeyOf.set(key, { caseNo: r.case_no, itemNo: r.item_no });
      return { caseNo, cortOfcCd: courtCodeByName(r.court) ?? '', itemNo };
    }).filter((c) => c.cortOfcCd);
    return { courtOf, dbKeyOf, cases };
  };

  const tracker: PhaseTracker = { failures: [] };

  // ── 1차: 활성/예정 (진행물건 상세 pgj15B) ──
  const daysBack = Number(process.env.RESULT_DAYS_BACK) || 5;
  const daysFwd = Number(process.env.RESULT_DAYS_FWD) || 21;
  const limit = Number(process.env.RESULT_LIMIT) || 300;
  const a = toCases(await query<Row>(
    `select distinct l.case_no, coalesce(nullif(l.item_no,''),'1') item_no, l.court, l.sale_date
       from gm_listings l
      where l.sale_date >= current_date - $1::int and l.sale_date <= current_date + $2::int
        and not exists (select 1 from gm_auction_results r where r.case_no=l.case_no and r.item_no=coalesce(nullif(l.item_no,''),'1') and r.sold)
      order by l.sale_date limit $3`,
    [daysBack, daysFwd, limit],
  ));
  console.log(`[collect-results] 1차(활성) 대상 ${a.cases.length}건…`);
  const c1: Counters = { upserted: 0, sold: 0, refreshed: 0 };
  await runPhase('1차 활성 결과 수집', tracker, undefined, () => collectSaleResults(a.cases, (key, rounds) => {
    const [caseNo, itemNo] = key.split('|');
    const dbKey = a.dbKeyOf.get(key) ?? { caseNo: caseNo!, itemNo: itemNo! };
    return recordRounds(dbKey.caseNo, dbKey.itemNo, a.courtOf.get(key) ?? null, rounds, today, c1);
  }).then(() => undefined));
  console.log(`[collect-results] 1차: upsert ${c1.upserted} · 매각 ${c1.sold} · 기일갱신 ${c1.refreshed}`);

  // ── 2차: 과거/종결 미수집 소급 (경매사건검색 pgj15A) ──
  const backfillLimit = Number(process.env.RESULT_BACKFILL_LIMIT) || 60;
  const b = toCases(await query<Row>(
    `select distinct l.case_no, coalesce(nullif(l.item_no,''),'1') item_no, l.court, l.sale_date
       from gm_listings l
      where l.source='courtauction' and l.sale_date < current_date
        and not exists (select 1 from gm_auction_results r
           where r.case_no=l.case_no and r.item_no=coalesce(nullif(l.item_no,''),'1')
             and (r.sold or r.captured_at > now() - interval '6 days'))
      order by l.sale_date desc limit $1`,
    [backfillLimit],
  ));
  console.log(`[collect-results] 2차(소급 pgj15A) 대상 ${b.cases.length}건…`);
  const c2: Counters = { upserted: 0, sold: 0, refreshed: 0 };
  await runPhase('2차 종결 소급 수집', tracker, undefined, () => collectCaseResults(b.cases, (key, rounds) => {
    const [caseNo, itemNo] = key.split('|');
    const dbKey = b.dbKeyOf.get(key) ?? { caseNo: caseNo!, itemNo: itemNo! };
    return recordRounds(dbKey.caseNo, dbKey.itemNo, b.courtOf.get(key) ?? null, rounds, today, c2);
  }).then(() => undefined));
  console.log(`[collect-results] 2차: upsert ${c2.upserted} · 매각 ${c2.sold} · 기일갱신 ${c2.refreshed}`);

  // ── 3차: Phase2 복기 미매칭 스냅샷 직접 소급 ──
  const evalBackfillLimit = Number(process.env.RESULT_EVAL_BACKFILL_LIMIT) || 300;
  const e = toCases(await query<Row>(
    `select distinct case_no, item_no, court, sale_date
       from gm_outcome_eval
      where sale_date < current_date and matched = false
      order by sale_date desc limit $1`,
    [evalBackfillLimit],
  ));
  console.log(`[collect-results] 3차(Phase2 미매칭) 대상 ${e.cases.length}건…`);
  const c3: Counters = { upserted: 0, sold: 0, refreshed: 0 };
  const activeRounds = await runPhase('3차 Phase2 진행물건 수집', tracker, new Map<string, SaleResultRound[]>(), () => collectSaleResults(e.cases, (key, rounds) => {
    const [caseNo, itemNo] = key.split('|');
    const dbKey = e.dbKeyOf.get(key) ?? { caseNo: caseNo!, itemNo: itemNo! };
    return recordRounds(dbKey.caseNo, dbKey.itemNo, e.courtOf.get(key) ?? null, rounds, today, c3);
  }));
  const closedCases = e.cases.filter((c) => (activeRounds.get(`${c.caseNo}|${c.itemNo}`)?.length ?? 0) === 0);
  if (closedCases.length) {
    await runPhase('3차 Phase2 종결사건 수집', tracker, undefined, () => collectCaseResults(closedCases, (key, rounds) => {
      const [caseNo, itemNo] = key.split('|');
      const dbKey = e.dbKeyOf.get(key) ?? { caseNo: caseNo!, itemNo: itemNo! };
      return recordRounds(dbKey.caseNo, dbKey.itemNo, e.courtOf.get(key) ?? null, rounds, today, c3);
    }).then(() => undefined));
  }
  console.log(`[collect-results] 3차: active ${activeRounds.size} · closed ${closedCases.length} · upsert ${c3.upserted} · 매각 ${c3.sold} · 기일갱신 ${c3.refreshed}`);
  const totalUpserted = c1.upserted + c2.upserted + c3.upserted;
  if (tracker.failures.length) {
    console.error(`[collect-results] 실패 단계 ${tracker.failures.length}개: ${tracker.failures.join(' / ')}`);
    if (totalUpserted === 0) process.exitCode = 1;
  }
  await pool().end();
}

main().catch((e) => { console.error('collect-results 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
