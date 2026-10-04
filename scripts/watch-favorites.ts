/**
 * 관심물건(★) 변동 감시(발품절감 ②) — 기일 변경·유찰·최저가 하락·매각·문서 갱신(⑤)을 직전 상태와 diff.
 *   변동이 있을 때만 텔레그램용 텍스트를 stdout으로 출력(없으면 무출력 = 발송 생략).
 *   발송은 deploy/daily-parse.sh·evening-collect.sh가 stdout을 받아 notify-telegram.sh로(이 스크립트는 조회·기록만).
 * 사용: npm run watch:favs   (첫 실행은 상태 씨딩만 하고 침묵)
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import { diffFavorite, formatWatch, type FavChangeBlock, type FavSnapshot } from './watch-format.ts';

interface FavRow extends FavSnapshot {
  listing_id: number;
  prev_sale_date: string | null;
  prev_min_bid: number | null;
  prev_fail: number | null;
  prev_sold: boolean | null;   // null = 상태 없음(첫 관측)
  interest_cnt: number | null;      // 오늘 관심수
  prev_interest: number | null;     // 직전 스냅샷 관심수(gm_competition_history)
}

const INTEREST_JUMP = Number(process.env.WATCH_INTEREST_JUMP) || 3; // 관심 급증 임계(+명)

async function main(): Promise<void> {
  const favs = await query<FavRow>(
    `select l.id as listing_id, l.case_no, l.address, l.sale_date::text, l.min_bid_price::float8,
            l.fail_count,
            exists(select 1 from gm_auction_results r
                    where r.case_no = l.case_no and r.item_no = coalesce(l.item_no,'1') and r.sold) as sold,
            w.sale_date::text as prev_sale_date, w.min_bid_price::float8 as prev_min_bid,
            w.fail_count as prev_fail, w.sold as prev_sold,
            l.interest_cnt,
            (select h.interest_cnt from gm_competition_history h
              where h.case_no = l.case_no and h.item_no = coalesce(l.item_no,'1')
                and h.captured_date < current_date
              order by h.captured_date desc limit 1) as prev_interest
       from gm_listings l
       left join gm_watch_state w on w.listing_id = l.id
      where l.is_favorite = true`,
  );

  const blocks: FavChangeBlock[] = [];
  for (const f of favs) {
    if (f.prev_sold != null) {
      const prev: FavSnapshot = {
        case_no: f.case_no, address: f.address,
        sale_date: f.prev_sale_date, min_bid_price: f.prev_min_bid, fail_count: f.prev_fail, sold: f.prev_sold,
      };
      const lines = diffFavorite(prev, f);
      // 경쟁 열기 급증 — 직전 스냅샷 대비 관심수 +INTEREST_JUMP 이상(남들이 몰리기 시작한 신호)
      if (!f.sold && f.interest_cnt != null && f.prev_interest != null && f.interest_cnt - f.prev_interest >= INTEREST_JUMP) {
        lines.push(`🔥 관심 급증 +${f.interest_cnt - f.prev_interest} (총 ${f.interest_cnt}명) — 경쟁 열기 상승`);
      }
      blocks.push({ caseNo: f.case_no, address: f.address, lines });
    }
    // 상태 upsert(첫 관측은 씨딩만 — 다음 실행부터 diff)
    await query(
      `insert into gm_watch_state (listing_id, sale_date, min_bid_price, fail_count, sold, updated_at)
       values ($1, $2::date, $3, $4, $5, now())
       on conflict (listing_id) do update set
         sale_date=excluded.sale_date, min_bid_price=excluded.min_bid_price,
         fail_count=excluded.fail_count, sold=excluded.sold, updated_at=now()`,
      [f.listing_id, f.sale_date, f.min_bid_price, f.fail_count, f.sold],
    );
  }

  // 문서 갱신(⑤) — ★매물의 미통지 변경을 블록에 병합 후 notified 마킹
  const docChanges = await query<{ id: number; listing_id: number; case_no: string; address: string; doc_types: string | null }>(
    `select dc.id, dc.listing_id, dc.case_no, l.address, dc.doc_types
       from gm_doc_changes dc join gm_listings l on l.id = dc.listing_id
      where dc.notified = false and l.is_favorite = true
      order by dc.changed_at`,
  );
  for (const c of docChanges) {
    const line = `📄 문서 갱신(${c.doc_types ?? '?'}) — 명세서·현황 변경 여부 재확인 권장`;
    const b = blocks.find((x) => x.caseNo === c.case_no);
    if (b) b.lines.push(line);
    else blocks.push({ caseNo: c.case_no, address: c.address, lines: [line] });
  }
  if (docChanges.length) {
    await query(`update gm_doc_changes set notified = true where id = any($1::bigint[])`, [docChanges.map((c) => c.id)]);
  }

  const text = formatWatch(blocks, process.env.DASHBOARD_URL || null);
  if (text) console.log(text);
  await pool().end();
}

main().catch((e) => { console.error('watch-favorites 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
