/**
 * 일일 추천 다이제스트 — gm_scores 통과 + 점수 상위 N건을 텔레그램용 텍스트로 출력(stdout).
 * 발송은 deploy/daily-parse.sh가 stdout을 받아 notify-telegram.sh로 전송(이 스크립트는 조회·포맷만 = 안전).
 * 사용: npm run digest   (DIGEST_TOP_N 기본 5)
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import { formatDigest, type DigestRow } from './digest-format.ts';

async function main(): Promise<void> {
  const N = Number(process.env.DIGEST_TOP_N) || 5;
  const rows = await query<DigestRow>(
    `select l.case_no, l.property_type, l.address,
            l.appraisal_value::float8, l.min_bid_price::float8, l.sale_date::text,
            l.source_url, l.inq_cnt, l.interest_cnt, l.crawled_at::text,
            r.risk_grade, loc.safety_margin::float8,
            (loc.acquisition_cost->>'trueSafetyMargin')::float8 as true_margin,
            s.total_score::int
       from gm_scores s
       join gm_listings l on l.id = s.listing_id
       left join gm_rights_analysis   r   on r.listing_id   = l.id
       left join gm_location_analysis loc on loc.listing_id = l.id
      where s.passed_filter = true and (l.sale_date is null or l.sale_date >= current_date)
      order by s.total_score desc nulls last
      limit $1`,
    [N],
  );
  const totalPassed = (await query<{ c: number }>(`select count(*)::int as c from gm_scores where passed_filter = true`))[0]?.c ?? rows.length;
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // KST
  console.log(formatDigest(rows, { today, totalPassed }));
  await pool().end();
}

main().catch((e) => { console.error('digest 실패:', e); process.exitCode = 1; });
