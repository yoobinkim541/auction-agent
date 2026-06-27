import { describe, it, expect } from 'vitest';
import { scoreClient, DEFAULT_CONFIG } from './scoring.ts';
import type { ListingItem } from './api.ts';

// web scoreClient 특성 고정(회귀 방지). 서버 pipeline/select/score.ts 와 핵심 산식(safety/clean 가중)은
// 같으나, web에는 dangerPenalty(-8/위험항목)·wSum 정규화가 추가돼 있다(아래 명시 테스트로 분기 문서화).
const mk = (over: Record<string, unknown> = {}): ListingItem => ({
  property_type: 'apartment', address: '서울시 강남구', min_bid_price: 200_000_000, appraisal_value: 300_000_000,
  rights: { risk_grade: 'clean', assumed_amount: 0 },
  location: { safety_margin: 0.2, acquisition_cost: { trueSafetyMargin: 0.2 }, report: { dangerCount: 0, headline: '' } },
  ...over,
} as unknown as ListingItem);

const loc = (o: Record<string, unknown>) => ({ location: { safety_margin: 0.2, acquisition_cost: { trueSafetyMargin: 0.2 }, report: { dangerCount: 0, headline: '' }, ...o } });

describe('web scoreClient', () => {
  it('기본(안전마진0.2·clean) → safety50·clean100·total75·통과', () => {
    const r = scoreClient(mk(), DEFAULT_CONFIG);
    expect(r).toMatchObject({ safetyScore: 50, cleanScore: 100, totalScore: 75, passed: true });
  });

  it('dangerPenalty(-8/건, 최대 -30) — 서버 score.ts엔 없는 web 전용 감점(드리프트 문서화)', () => {
    const r = scoreClient(mk(loc({ report: { dangerCount: 2, headline: '' } })), DEFAULT_CONFIG);
    expect(r.totalScore).toBe(75 - 16); // 2건 → -16
    const capped = scoreClient(mk(loc({ report: { dangerCount: 10, headline: '' } })), DEFAULT_CONFIG);
    expect(capped.totalScore).toBe(75 - 30); // 상한 -30
  });

  it('인수금액>0 → cleanScore≤20 + requireCleanRights 탈락', () => {
    const r = scoreClient(mk({ rights: { risk_grade: 'clean', assumed_amount: 50_000_000 } }), DEFAULT_CONFIG);
    expect(r.cleanScore).toBeLessThanOrEqual(20);
    expect(r.passed).toBe(false);
    expect(r.reasons.some((x) => x.includes('인수금액'))).toBe(true);
  });

  it('시세 미확보 + requireMarketPrice → 탈락', () => {
    const r = scoreClient(mk(loc({ safety_margin: null, acquisition_cost: null })), DEFAULT_CONFIG);
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain('시세 미확보');
  });

  it('데이터 불완전 헤드라인 → 탈락', () => {
    const r = scoreClient(mk(loc({ report: { dangerCount: 0, headline: '[데이터 불완전] 등기 미수집' } })), DEFAULT_CONFIG);
    expect(r.passed).toBe(false);
  });

  it('진짜마진 부족 → 사유에 "진짜마진" 표기(서버 label과 일치)', () => {
    // trueSafetyMargin(0.05) < minSafetyMargin(0.1) — raw margin은 0.3으로 충분
    const r = scoreClient(mk(loc({ safety_margin: 0.3, acquisition_cost: { trueSafetyMargin: 0.05 } })), DEFAULT_CONFIG);
    expect(r.passed).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('진짜마진'))).toBe(true);
    expect(r.reasons.every((x) => !x.startsWith('안전마진'))).toBe(true);
  });

  it('진짜마진 없을 때 raw 안전마진 부족 → 사유에 "안전마진" 표기', () => {
    const r = scoreClient(mk(loc({ safety_margin: 0.05, acquisition_cost: null })), DEFAULT_CONFIG);
    expect(r.passed).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('안전마진'))).toBe(true);
  });

  it('경쟁 신호 없으면 competitionScore=null·점수 중립(기존 75 유지)', () => {
    const r = scoreClient(mk(), DEFAULT_CONFIG);
    expect(r.competitionScore).toBeNull();
    expect(r.totalScore).toBe(75); // 경쟁 가중 미적용(신호 없음)
  });

  it('저경쟁(조회 0)이 고경쟁(조회 많음)보다 경쟁점수·총점 높음', () => {
    const low = scoreClient(mk({ inq_cnt: 0, interest_cnt: 0 }), DEFAULT_CONFIG);
    const high = scoreClient(mk({ inq_cnt: 80, interest_cnt: 10 }), DEFAULT_CONFIG);
    expect(low.competitionScore!).toBeGreaterThan(high.competitionScore!);
    expect(low.competitionScore).toBe(100);     // 압력 0 → 만점
    expect(low.totalScore).toBeGreaterThan(high.totalScore);
  });

  it('특수권리(위험 red_flag) → excludeSpecialRights 기본 탈락', () => {
    const r = scoreClient(mk({ rights: { risk_grade: 'caution', assumed_amount: 0, red_flags: [{ kind: 'yuchikwon', severity: 'danger', message: '유치권' }] } }), DEFAULT_CONFIG);
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain('특수권리(위험)');
    // 끄면 통과(다른 조건 충족 시)
    const r2 = scoreClient(mk({ rights: { risk_grade: 'caution', assumed_amount: 0, red_flags: [{ kind: 'yuchikwon', severity: 'danger', message: '유치권' }] } }), { ...DEFAULT_CONFIG, excludeSpecialRights: false });
    expect(r2.reasons).not.toContain('특수권리(위험)');
  });
});
