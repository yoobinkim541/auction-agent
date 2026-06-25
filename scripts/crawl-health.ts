/**
 * 크롤 수집 헬스체크 — status=ok 라도 n_found=0이면 실제론 굶고 있는 걸 잡아낸다.
 * 사용: npm run crawl:health    (cron에 걸고 비정상(exit 1) 시 알림으로 연결)
 *   임계: CRAWL_HEALTH_MAX_AGE_HOURS(기본 48) 내 실수집(n_found>0)이 없으면 비정상.
 * exit code: 0=정상, 1=비정상(굶음), 2=조회 실패.
 */
import 'dotenv/config';
import { recentCrawlRuns, pool } from '../shared/db.ts';
import { evaluateCrawlHealth } from '../shared/crawl-health.ts';

const MAX_AGE_H = Number(process.env.CRAWL_HEALTH_MAX_AGE_HOURS) || 48;

async function main(): Promise<void> {
  const rows = await recentCrawlRuns(50);
  const h = evaluateCrawlHealth(rows, Date.now(), MAX_AGE_H);

  console.log(`${h.healthy ? '✅' : '⛔'} 크롤 수집 헬스 — ${h.healthy ? '정상' : '비정상(신규 수집 굶음)'}`);
  console.log(`  마지막 실수집(n_found>0): ${h.lastHarvestAt ?? '없음'}${h.hoursSinceHarvest != null ? ` · ${h.hoursSinceHarvest}h 전` : ''} (임계 ${MAX_AGE_H}h)`);
  console.log(`  최근 연속 0건 수집: ${h.recentEmptyStreak}회`);
  for (const s of h.bySource) {
    console.log(`  - ${s.source}: 최근 ${s.lastStatus} · ${s.lastFound}건 @ ${s.lastAt ?? '?'}`);
  }
  if (h.reasons.length) console.log(`  사유: ${h.reasons.join(' · ')}`);

  if (!h.healthy) process.exitCode = 1;
  await pool().end();
}

main().catch((e) => {
  console.error('헬스체크 실패:', e);
  process.exitCode = 2;
});
