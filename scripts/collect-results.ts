/**
 * 결과 수집(학습 Phase 1) — 최근 매각기일이 지났거나 임박한 사건의 기일결과(낙찰가·유찰)를
 * 법원경매 상세(gdsDspslDxdyLst)에서 조회해 gm_auction_results에 upsert.
 *
 * 매각된 사건은 상세 엔드포인트에서 며칠 내 사라지므로 **매일 폴링**해 윈도우 안에서 포착한다.
 * (응찰자수는 이 엔드포인트에 없음 — 추후 별도 캡처.) CRAWL_PROXY(집-IP 터널) 경유 필요.
 * 사용: npm run collect:results   (RESULT_DAYS_BACK 기본 10, RESULT_LIMIT 기본 150)
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import { collectSaleResults, courtCodeByName, queryableCourtNames, nextSaleDate, failedRoundCount } from '../crawler/adapters/courtauction.ts';

async function main(): Promise<void> {
  // 진행물건 상세는 활성/예정 사건만 회차내역을 돌려준다(매각 완료 후 며칠 내 사라짐).
  //  → 최근 매각기일(today-daysBack, 매각결과 포착 윈도우) + 예정(today+daysFwd, 유찰이력 누적)을 대상으로.
  //  코드 매핑 가능한 법원으로 SQL에서 미리 필터(미조회 법원에 limit 낭비 방지).
  const daysBack = Number(process.env.RESULT_DAYS_BACK) || 5;
  const daysFwd = Number(process.env.RESULT_DAYS_FWD) || 21;
  const limit = Number(process.env.RESULT_LIMIT) || 300;
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // KST

  const rows = await query<{ case_no: string; item_no: string; court: string; sale_date: string }>(
    `select distinct l.case_no, coalesce(l.item_no,'1') item_no, l.court, l.sale_date
       from gm_listings l
      where l.court = any($1::text[])
        and l.sale_date >= current_date - $2::int and l.sale_date <= current_date + $3::int
        and not exists (
          select 1 from gm_auction_results r
           where r.case_no = l.case_no and r.item_no = coalesce(l.item_no,'1') and r.sold)
      order by l.sale_date
      limit $4`,
    [queryableCourtNames(), daysBack, daysFwd, limit],
  );

  const courtOf = new Map<string, string>(rows.map((r) => [`${r.case_no}|${r.item_no}`, r.court]));
  const cases = rows
    .map((r) => ({ caseNo: r.case_no, cortOfcCd: courtCodeByName(r.court) ?? '', itemNo: r.item_no }))
    .filter((c) => c.cortOfcCd);
  console.log(`[collect-results] 대상 ${cases.length}건 — 상세 조회 중…`);

  // 사건별 즉시 upsert(콜백) — 타임아웃/중단에도 진행분 보존.
  let upserted = 0, sold = 0, withRounds = 0, refreshed = 0;
  await collectSaleResults(cases, async (key, rounds) => {
    withRounds++;
    const [caseNo, itemNo] = key.split('|');
    const court = courtOf.get(key) ?? null;
    for (const rd of rounds) {
      await query(
        `insert into gm_auction_results (case_no,item_no,court,dxdy_date,kind_cd,result_cd,min_price,sold_amount,sold,captured_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         on conflict (case_no,item_no,dxdy_date) do update set
           kind_cd=excluded.kind_cd, result_cd=excluded.result_cd, min_price=excluded.min_price,
           sold_amount=excluded.sold_amount, sold=excluded.sold, captured_at=now()`,
        [caseNo, itemNo, court, rd.date, rd.kindCd, rd.resultCd, rd.minPrice, rd.soldAmount, rd.sold],
      );
      upserted++;
      if (rd.sold) sold++;
    }
    // ② 유찰분 다음 회차 기일을 gm_listings.sale_date에 반영(D+로 죽지 않게). 변경 있을 때만.
    const next = nextSaleDate(rounds, today);
    if (next) {
      const res = await query(
        `update gm_listings set sale_date=$1::date, min_bid_price=coalesce($2, min_bid_price), fail_count=$3
           where case_no=$4 and coalesce(item_no,'1')=$5 and sale_date is distinct from $1::date
         returning case_no`,
        [next.date, next.minPrice, failedRoundCount(rounds, today), caseNo, itemNo],
      );
      if (res.length) refreshed++;
    }
  });
  console.log(`[collect-results] 기일보유 사건 ${withRounds} · upsert ${upserted}행 · 매각(낙찰) ${sold}건 · 기일갱신 ${refreshed}건`);
  await pool().end();
}

main().catch((e) => { console.error('collect-results 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
