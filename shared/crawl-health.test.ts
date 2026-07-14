import { describe, it, expect } from 'vitest';
import { evaluateCrawlHealth, type CrawlRunRow } from './crawl-health.ts';

const H = 3_600_000;
const NOW = Date.parse('2026-06-25T12:00:00Z');
const run = (over: Partial<CrawlRunRow>): CrawlRunRow => ({
  id: 1, source: 'deonakchal', status: 'ok', n_found: 0, n_new: 0,
  started_at: new Date(NOW).toISOString(), finished_at: new Date(NOW).toISOString(), ...over,
});

describe('evaluateCrawlHealth', () => {
  it('최근 실수집이 임계 내 → 정상', () => {
    const h = evaluateCrawlHealth([run({ n_found: 50, started_at: new Date(NOW - 5 * H).toISOString() })], NOW, 48);
    expect(h.healthy).toBe(true);
    expect(h.hoursSinceHarvest).toBe(5);
    expect(h.reasons).toEqual([]);
  });

  it('status=ok 인데 n_found=0만 쌓임 → 비정상(굶음) + 연속카운트', () => {
    const rows = [0, 1, 2, 3].map((d) => run({ id: d, status: 'ok', n_found: 0, started_at: new Date(NOW - d * 24 * H).toISOString() }));
    const h = evaluateCrawlHealth(rows, NOW, 48);
    expect(h.healthy).toBe(false);                 // ok로 찍혀도 실수집 0 → 굶음 감지
    expect(h.hoursSinceHarvest).toBeNull();        // n_found>0 런 없음
    expect(h.recentEmptyStreak).toBe(4);
    expect(h.reasons.some((r) => r.includes('연속 0건'))).toBe(true);
  });

  it('마지막 실수집이 임계 초과 → 비정상 + 경과 사유', () => {
    const rows = [
      run({ id: 9, status: 'blocked', n_found: 0, started_at: new Date(NOW - 2 * H).toISOString() }),
      run({ id: 1, status: 'ok', n_found: 1000, started_at: new Date(NOW - 240 * H).toISOString() }), // 10일 전
    ];
    const h = evaluateCrawlHealth(rows, NOW, 48);
    expect(h.healthy).toBe(false);
    expect(h.hoursSinceHarvest).toBe(240);
    expect(h.reasons.some((r) => r.includes('경과'))).toBe(true);
    expect(h.reasons.some((r) => r.includes('deonakchal 최근=blocked'))).toBe(true);
  });

  it('소스별 최신 런 요약(최신순 무관 입력)', () => {
    const rows = [
      run({ id: 1, source: 'deonakchal', status: 'blocked', n_found: 0, started_at: new Date(NOW - 1 * H).toISOString() }),
      run({ id: 2, source: 'courtauction', status: 'ok', n_found: 0, started_at: new Date(NOW - 2 * H).toISOString() }),
      run({ id: 3, source: 'deonakchal', status: 'ok', n_found: 7, started_at: new Date(NOW - 30 * H).toISOString() }),
    ];
    const h = evaluateCrawlHealth(rows, NOW, 48);
    const dn = h.bySource.find((s) => s.source === 'deonakchal')!;
    expect(dn.lastStatus).toBe('blocked'); // 최신 런 기준
    expect(h.bySource.find((s) => s.source === 'courtauction')!.lastFound).toBe(0);
  });

  it('진행 중인 running 0건은 연속 0건 실패로 세지 않음', () => {
    const rows = [
      run({ id: 9, source: 'courtauction', status: 'running', n_found: 0, started_at: new Date(NOW).toISOString(), finished_at: null }),
      run({ id: 1, source: 'courtauction', status: 'ok', n_found: 380, started_at: new Date(NOW - 1 * H).toISOString() }),
    ];
    const h = evaluateCrawlHealth(rows, NOW, 48);
    expect(h.healthy).toBe(true);
    expect(h.recentEmptyStreak).toBe(0);
    expect(h.bySource.find((s) => s.source === 'courtauction')!.lastStatus).toBe('running');
  });

  it('기록 없음 → 비정상', () => {
    const h = evaluateCrawlHealth([], NOW, 48);
    expect(h.healthy).toBe(false);
    expect(h.reasons).toContain('크롤런 기록 없음');
  });
});
