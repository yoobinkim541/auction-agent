/**
 * 일일 추천 다이제스트 — gm_precision_shortlist 정밀 후보 상위 N건 + 데이터 신선도 + 어제 기일 결과 회고를 텍스트로 출력(stdout).
 * 발송은 deploy/daily-parse.sh가 stdout을 받아 notify-telegram.sh(경매봇)로 전송(이 스크립트는 조회·포맷만 = 안전).
 * 사용: npm run digest   (DIGEST_TOP_N 기본 5)
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import { formatDigest, formatResultsRecap, formatUpcoming, type DigestRow, type DigestResult } from './digest-format.ts';
import { bandLine, compsStats, fetchCompsWithFallback, regionKey, type CompsStats } from '../pipeline/predict/comps.ts';
import {
  clampDigestTopN, HISTORICAL_RESULTS_SQL, SHORTLIST_COUNT_SQL, TOP_RECOMMENDATIONS_SQL,
  UPCOMING_RECOMMENDATIONS_SQL,
} from './digest-queries.ts';

async function main(): Promise<void> {
  const N = clampDigestTopN(process.env.DIGEST_TOP_N);
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // KST

  const rows = await query<DigestRow>(
    TOP_RECOMMENDATIONS_SQL,
    [N],
  );
  const totalPassed = (await query<{ c: number }>(SHORTLIST_COUNT_SQL))[0]?.c ?? rows.length;

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
    HISTORICAL_RESULTS_SQL,
  );

  // 이번 주 입찰 후보(통과 + 매각기일 7일 이내, 임박순)
  const upcoming = await query<DigestRow>(
    UPCOMING_RECOMMENDATIONS_SQL,
  );

  const dashboardBase = process.env.DASHBOARD_URL || null;
  const digest = formatDigest(rows, { today, totalPassed, dataAsOf, dataAgeDays, dashboardBase });
  const week = formatUpcoming(upcoming, today);
  const recap = formatResultsRecap(results, '최근');
  console.log([digest, week, recap].filter(Boolean).join('\n\n'));
  await pool().end();
}

main().catch((e) => { console.error('digest 실패:', e); process.exitCode = 1; });
