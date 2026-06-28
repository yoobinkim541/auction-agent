/**
 * 결과 수집(학습) — 법원경매 사건 결과(낙찰가·유찰·차기기일)를 gm_auction_results에 적재 + 유찰분 sale_date 백필.
 *  1차(활성/예정): 진행물건 상세(pgj15B) gdsDspslDxdyLst — 유찰이력·진행 차기기일.
 *  2차(과거/종결 소급): 경매사건검색(pgj15A) — 종결 후에도 낙찰가·결과(현 D+ 등 미수집분). docs/courtauction-result-endpoint.md.
 * 매각된 사건은 진행물건 상세에서 곧 사라지므로 매일 폴링 + 2차 소급으로 보완. (응찰자수 미제공 — 관심수 proxy.)
 * 사용: npm run collect:results   (RESULT_DAYS_BACK 5 · RESULT_DAYS_FWD 21 · RESULT_LIMIT 300 · RESULT_BACKFILL_LIMIT 60)
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import {
  collectSaleResults, collectCaseResults, courtCodeByName, queryableCourtNames,
  nextSaleDate, failedRoundCount, type SaleResultRound,
} from '../crawler/adapters/courtauction.ts';

interface Counters { upserted: number; sold: number; refreshed: number }

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
         where case_no=$4 and coalesce(item_no,'1')=$5 and sale_date is distinct from $1::date
       returning case_no`,
      [next.date, next.minPrice, failedRoundCount(rounds, today), caseNo, itemNo],
    );
    if (res.length) ctr.refreshed++;
  }
}

async function main(): Promise<void> {
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // KST
  const courts = queryableCourtNames();
  type Row = { case_no: string; item_no: string; court: string; sale_date: string };
  const toCases = (rows: Row[]) => ({
    courtOf: new Map<string, string>(rows.map((r) => [`${r.case_no}|${r.item_no}`, r.court])),
    cases: rows.map((r) => ({ caseNo: r.case_no, cortOfcCd: courtCodeByName(r.court) ?? '', itemNo: r.item_no })).filter((c) => c.cortOfcCd),
  });

  // ── 1차: 활성/예정 (진행물건 상세 pgj15B) ──
  const daysBack = Number(process.env.RESULT_DAYS_BACK) || 5;
  const daysFwd = Number(process.env.RESULT_DAYS_FWD) || 21;
  const limit = Number(process.env.RESULT_LIMIT) || 300;
  const a = toCases(await query<Row>(
    `select distinct l.case_no, coalesce(l.item_no,'1') item_no, l.court, l.sale_date
       from gm_listings l
      where l.court = any($1::text[]) and l.sale_date >= current_date - $2::int and l.sale_date <= current_date + $3::int
        and not exists (select 1 from gm_auction_results r where r.case_no=l.case_no and r.item_no=coalesce(l.item_no,'1') and r.sold)
      order by l.sale_date limit $4`,
    [courts, daysBack, daysFwd, limit],
  ));
  console.log(`[collect-results] 1차(활성) 대상 ${a.cases.length}건…`);
  const c1: Counters = { upserted: 0, sold: 0, refreshed: 0 };
  await collectSaleResults(a.cases, (key, rounds) => {
    const [caseNo, itemNo] = key.split('|');
    return recordRounds(caseNo!, itemNo!, a.courtOf.get(key) ?? null, rounds, today, c1);
  });
  console.log(`[collect-results] 1차: upsert ${c1.upserted} · 매각 ${c1.sold} · 기일갱신 ${c1.refreshed}`);

  // ── 2차: 과거/종결 미수집 소급 (경매사건검색 pgj15A) ──
  const backfillLimit = Number(process.env.RESULT_BACKFILL_LIMIT) || 60;
  const b = toCases(await query<Row>(
    `select distinct l.case_no, coalesce(l.item_no,'1') item_no, l.court, l.sale_date
       from gm_listings l
      where l.court = any($1::text[]) and l.source='courtauction' and l.sale_date < current_date
        and not exists (select 1 from gm_auction_results r
           where r.case_no=l.case_no and r.item_no=coalesce(l.item_no,'1')
             and (r.sold or r.captured_at > now() - interval '6 days'))
      order by l.sale_date desc limit $2`,
    [courts, backfillLimit],
  ));
  console.log(`[collect-results] 2차(소급 pgj15A) 대상 ${b.cases.length}건…`);
  const c2: Counters = { upserted: 0, sold: 0, refreshed: 0 };
  await collectCaseResults(b.cases, (key, rounds) => {
    const [caseNo, itemNo] = key.split('|');
    return recordRounds(caseNo!, itemNo!, b.courtOf.get(key) ?? null, rounds, today, c2);
  });
  console.log(`[collect-results] 2차: upsert ${c2.upserted} · 매각 ${c2.sold} · 기일갱신 ${c2.refreshed}`);
  await pool().end();
}

main().catch((e) => { console.error('collect-results 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
