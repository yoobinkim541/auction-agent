/**
 * 크롤 수집 헬스 평가(순수 함수 — DB/IO 없음).
 * gm_crawl_runs 행들을 받아 "신규 수집이 굶고 있는지"를 판정한다. status=ok 라도 n_found=0이면
 * 실제론 한 건도 못 가져온 것 → 대시보드가 '정상'으로 보이는 함정을 잡는다.
 */
export interface CrawlRunRow {
  id: number;
  source: string;
  status: string;
  n_found: number;
  n_new: number;
  started_at: string | Date;
  finished_at: string | Date | null;
}

export interface SourceHealth {
  source: string;
  lastStatus: string;
  lastFound: number;
  lastAt: string | null;
}

export interface CrawlHealth {
  healthy: boolean;
  lastHarvestAt: string | null; // 마지막으로 n_found>0 였던 런 시각(ISO)
  hoursSinceHarvest: number | null; // null = 실수집 기록 자체가 없음
  recentEmptyStreak: number; // 최신부터 연속 0건 수집 런 수
  bySource: SourceHealth[];
  reasons: string[]; // 비정상 사유(정상이면 빈 배열)
}

const toMs = (d: string | Date | null): number | null => {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};
const toIso = (d: string | Date | null): string | null => {
  const t = toMs(d);
  return t == null ? null : new Date(t).toISOString();
};

/**
 * @param rows  최근 크롤런(정렬 무관 — 내부에서 started_at desc 정렬)
 * @param nowMs 현재 시각(ms) — 호출부에서 Date.now() 주입(테스트 결정성)
 * @param maxAgeHours 이 시간 내 실수집(n_found>0)이 없으면 비정상(기본 48h — 일일 크롤 + 하루 여유)
 */
export function evaluateCrawlHealth(rows: CrawlRunRow[], nowMs: number, maxAgeHours = 48): CrawlHealth {
  const sorted = [...rows].sort((a, b) => (toMs(b.started_at) ?? 0) - (toMs(a.started_at) ?? 0));

  const lastHarvest = sorted.find((r) => (r.n_found ?? 0) > 0) ?? null;
  const lastHarvestMs = lastHarvest ? toMs(lastHarvest.started_at) : null;
  const hoursSinceHarvest = lastHarvestMs == null ? null : (nowMs - lastHarvestMs) / 3_600_000;

  let recentEmptyStreak = 0;
  for (const r of sorted) {
    if ((r.n_found ?? 0) > 0) break;
    recentEmptyStreak++;
  }

  const bySource: SourceHealth[] = [];
  const seen = new Set<string>();
  for (const r of sorted) {
    if (seen.has(r.source)) continue;
    seen.add(r.source);
    bySource.push({ source: r.source, lastStatus: r.status, lastFound: r.n_found ?? 0, lastAt: toIso(r.started_at) });
  }

  const reasons: string[] = [];
  if (sorted.length === 0) reasons.push('크롤런 기록 없음');
  if (hoursSinceHarvest == null) {
    if (sorted.length) reasons.push('실수집(n_found>0) 기록이 전혀 없음');
  } else if (hoursSinceHarvest > maxAgeHours) {
    reasons.push(`마지막 실수집 후 ${Math.round(hoursSinceHarvest)}h 경과(>${maxAgeHours}h)`);
  }
  if (recentEmptyStreak >= 3) reasons.push(`최근 ${recentEmptyStreak}회 연속 0건 수집`);
  for (const s of bySource) {
    if (s.lastStatus === 'blocked') reasons.push(`${s.source} 최근=blocked`);
    else if (s.lastStatus === 'error') reasons.push(`${s.source} 최근=error`);
  }

  const healthy = hoursSinceHarvest != null && hoursSinceHarvest <= maxAgeHours;
  return {
    healthy,
    lastHarvestAt: toIso(lastHarvestMs == null ? null : new Date(lastHarvestMs)),
    hoursSinceHarvest: hoursSinceHarvest == null ? null : Math.round(hoursSinceHarvest * 10) / 10,
    recentEmptyStreak,
    bySource,
    reasons,
  };
}
