import { describe, it, expect } from 'vitest';
import { memoHash, buildMemoPrompt, type MemoCandidate } from './memo.ts';
import type { ListingReport } from '../../shared/types.ts';

const report = (over: Partial<ListingReport> = {}): ListingReport => ({
  headline: '[검토 권장] 시세 5억 · 최저가 3억 · 안전마진 40% · 진짜마진 35% · 인수 없음 · 위험 0/주의 1건',
  recommendation: 'consider', summary: ['감정 5억 → 최저 3억'], rightsSummary: '말소기준 근저당. 인수 0.',
  locationSummary: '최근접 역삼역. 시세근거 인근 실거래.', costSummary: '총취득 3.3억. 진짜마진 35%.',
  checklist: [], dangerCount: 0, warnCount: 1, ...over,
});

const cand = (over: Partial<MemoCandidate> = {}): MemoCandidate => ({
  id: 1, caseNo: '2025타경1', address: '서울 강남구 역삼동', propertyType: 'apartment',
  appraisal: 5e8, minBid: 3e8, safetyMargin: 0.4, totalScore: 88, inq: 3, interest: 1, report: report(), ...over,
});

describe('memoHash', () => {
  it('동일 입력 → 동일 해시(결정적)', () => {
    expect(memoHash(cand())).toBe(memoHash(cand()));
  });
  it('최저가 변하면 해시 변동(재생성 유발)', () => {
    expect(memoHash(cand())).not.toBe(memoHash(cand({ minBid: 2.5e8 })));
  });
  it('결론(recommendation) 변하면 해시 변동', () => {
    expect(memoHash(cand())).not.toBe(memoHash(cand({ report: report({ recommendation: 'avoid' }) })));
  });
});

describe('buildMemoPrompt', () => {
  it('사건·지표·자동결론·권리/입지/비용을 입력에 포함', () => {
    const p = buildMemoPrompt(cand());
    expect(p).toContain('2025타경1');
    expect(p).toContain('서울 강남구 역삼동');
    expect(p).toContain('투자 의견서');
    expect(p).toContain('진짜 안전마진'); // 형식 지시
    expect(p).toContain('역삼역'); // 입지 요약 전달
    expect(p).toContain('조회 3·관심 1'); // 경쟁 신호 전달
  });
  it('경쟁 데이터 없으면 안내 문구', () => {
    expect(buildMemoPrompt(cand({ inq: null, interest: null }))).toContain('경쟁 데이터 없음');
  });
});
