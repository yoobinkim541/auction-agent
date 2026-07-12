/**
 * 일일 추천 다이제스트 — gm_scores 통과 + 점수 상위 N건 + 데이터 신선도 + 어제 기일 결과 회고를 텍스트로 출력(stdout).
 * 발송은 deploy/daily-parse.sh가 stdout을 받아 notify-telegram.sh(경매봇)로 전송(이 스크립트는 조회·포맷만 = 안전).
 * 사용: npm run digest   (DIGEST_TOP_N 기본 5)
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import { formatDigest, formatResultsRecap, formatUpcoming, type DigestRow, type DigestResult } from './digest-format.ts';
import { bandLine, compsStats, fetchCompsWithFallback, regionKey, type CompsStats } from '../pipeline/predict/comps.ts';

async function main(): Promise<void> {
  const N = Number(process.env.DIGEST_TOP_N) || 5;
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // KST

  const rows = await query<DigestRow>(
    `select l.case_no, l.property_type, l.address,
            l.appraisal_value::float8, l.min_bid_price::float8, l.sale_date::text,
            l.source_url, l.inq_cnt, l.interest_cnt, l.crawled_at::text,
            r.risk_grade, loc.safety_margin::float8,
            (loc.acquisition_cost->>'trueSafetyMargin')::float8 as true_margin,
            s.total_score::int, (loc.report->>'memo') as memo
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

  // 낙찰가 예측 밴드(comps) — 같은 시군구·유형의 실제 낙찰가율 분포. 지역+유형별 1회만 조회(캐시).
  const statsCache = new Map<string, CompsStats | null>();
  for (const r of rows) {
    const key = `${r.property_type}|${regionKey(r.address)}`;
    if (!statsCache.has(key)) {
      const { sales } = await fetchCompsWithFallback(r.property_type, r.address).catch(() => ({ sales: [] }));
      statsCache.set(key, compsStats(sales));
    }
    r.predicted_band = bandLine(r.appraisal_value, statsCache.get(key) ?? null);
  }

  // 데이터 신선도: 마지막으로 실제 수집(n_found>0)한 날 (침묵 방지)
  const harvest = await query<{ d: string | null; age: number | null }>(
    `select max(started_at)::date::text as d, (current_date - max(started_at)::date) as age from gm_crawl_runs where n_found > 0`,
  );
  const dataAsOf = harvest[0]?.d ?? null;
  const dataAgeDays = harvest[0]?.age ?? null;

  // 어제~최근 3일 기일 결과(회고)
  const results = await query<DigestResult>(
    `select l.case_no, l.property_type, l.address, l.appraisal_value::float8,
            r.sold, r.sold_amount::float8,
            case when r.sold and l.appraisal_value > 0 then r.sold_amount::float8 / l.appraisal_value end as sale_ratio,
            coalesce(s.passed_filter, false) as was_recommended
       from gm_auction_results r
       join gm_listings l on l.case_no = r.case_no and coalesce(l.item_no,'1') = r.item_no
       left join gm_scores s on s.listing_id = l.id
      where r.kind_cd = '01' and r.dxdy_date >= current_date - 3 and r.dxdy_date < current_date
      order by r.sold desc, sale_ratio desc nulls last`,
  );

  // 이번 주 입찰 후보(통과 + 매각기일 7일 이내, 임박순)
  const upcoming = await query<DigestRow>(
    `select l.case_no, l.property_type, l.address, l.appraisal_value::float8, l.min_bid_price::float8,
            l.sale_date::text, l.source_url, l.inq_cnt, l.interest_cnt, l.crawled_at::text,
            r.risk_grade, loc.safety_margin::float8, (loc.acquisition_cost->>'trueSafetyMargin')::float8 as true_margin,
            s.total_score::int, null as memo
       from gm_scores s join gm_listings l on l.id = s.listing_id
       left join gm_rights_analysis r on r.listing_id = l.id
       left join gm_location_analysis loc on loc.listing_id = l.id
      where s.passed_filter = true and l.sale_date >= current_date and l.sale_date <= current_date + 7
      order by l.sale_date, s.total_score desc nulls last`,
  );

  const dashboardBase = process.env.DASHBOARD_URL || null;
  const digest = formatDigest(rows, { today, totalPassed, dataAsOf, dataAgeDays, dashboardBase });
  const week = formatUpcoming(upcoming, today);
  const recap = formatResultsRecap(results, '최근');
  console.log([digest, week, recap].filter(Boolean).join('\n\n'));
  await pool().end();
}

main().catch((e) => { console.error('digest 실패:', e); process.exitCode = 1; });
