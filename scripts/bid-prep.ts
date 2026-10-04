/**
 * D-1 입찰 준비 패키지(발품절감 ③) — 내일 매각기일인 통과/★ 매물의 보증금·법원·딥링크·준비물을 텍스트로 출력.
 *   대상이 없으면 무출력(발송 생략). 발송은 deploy/evening-collect.sh가 stdout을 받아 notify-telegram.sh로.
 * 사용: npm run bid:prep
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import { formatBidPrep, type BidPrepRow } from './bidprep-format.ts';
import { fetchCompsWithFallback, regionKey, winRateGuide, type CompSale } from '../pipeline/predict/comps.ts';

async function main(): Promise<void> {
  const tomorrow = new Date(Date.now() + 9 * 3_600_000 + 86_400_000).toISOString().slice(0, 10); // KST 내일
  const rows = await query<BidPrepRow>(
    `select l.case_no, l.property_type, l.address, l.court,
            l.appraisal_value::float8, l.min_bid_price::float8, s.total_score::int, l.is_favorite
       from gm_listings l
       left join gm_scores s on s.listing_id = l.id
      where l.sale_date = $1::date and (l.is_favorite = true or coalesce(s.passed_filter, false))
      order by l.is_favorite desc, s.total_score desc nulls last
      limit 10`,
    [tomorrow],
  );
  // 입찰가 가이드(승률) — 유사 낙찰가율 분위수. 지역+유형별 1회 조회 캐시.
  const cache = new Map<string, CompSale[]>();
  for (const r of rows) {
    const key = `${r.property_type}|${regionKey(r.address)}`;
    if (!cache.has(key)) {
      const { sales } = await fetchCompsWithFallback(r.property_type, r.address).catch(() => ({ sales: [] as CompSale[] }));
      cache.set(key, sales);
    }
    r.bid_guide = winRateGuide(r.appraisal_value, cache.get(key) ?? []);
  }
  const text = formatBidPrep(rows, tomorrow, process.env.DASHBOARD_URL || null);
  if (text) console.log(text);
  await pool().end();
}

main().catch((e) => { console.error('bid-prep 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
