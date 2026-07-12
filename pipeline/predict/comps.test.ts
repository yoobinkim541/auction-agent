import { describe, expect, it } from 'vitest';
import { bandLine, compsStats, recentSalesLines, regionKey, sidoKey } from './comps.ts';

describe('regionKey/sidoKey', () => {
  it('시군구 키(앞 두 토큰)를 만든다', () => {
    expect(regionKey('서울특별시 성북구 석관동 340-244')).toBe('서울특별시 성북구');
    expect(regionKey('경기도 용인시 기흥구 마북로123번길 9')).toBe('경기도 용인시');
    expect(sidoKey('인천광역시 미추홀구 매소홀로 262')).toBe('인천광역시');
  });
  it('토큰 1개 주소는 그대로', () => {
    expect(regionKey('서울특별시')).toBe('서울특별시');
  });
});

describe('compsStats', () => {
  it('표본 3건 미만이면 null(허위 정밀도 방지)', () => {
    expect(compsStats([])).toBeNull();
    expect(compsStats([{ soldAmount: 1, appraisal: 2 }, { soldAmount: 1, appraisal: 2 }])).toBeNull();
  });
  it('감정가/낙찰가 0·음수 표본은 제외한다', () => {
    expect(compsStats([
      { soldAmount: 0, appraisal: 1 }, { soldAmount: 1, appraisal: 0 },
      { soldAmount: 5, appraisal: 10 }, { soldAmount: 6, appraisal: 10 },
    ])).toBeNull();
  });
  it('중앙값·사분위 낙찰가율을 계산한다', () => {
    const s = compsStats([
      { soldAmount: 50, appraisal: 100 }, { soldAmount: 60, appraisal: 100 },
      { soldAmount: 64, appraisal: 100 }, { soldAmount: 70, appraisal: 100 },
      { soldAmount: 80, appraisal: 100 },
    ])!;
    expect(s.n).toBe(5);
    expect(s.medianRatio).toBeCloseTo(0.64);
    expect(s.p25).toBeCloseTo(0.6);
    expect(s.p75).toBeCloseTo(0.7);
  });
});

describe('bandLine', () => {
  const stats = { n: 14, medianRatio: 0.64, p25: 0.6, p75: 0.7 };
  it('감정가×p25~p75 밴드 한 줄을 만든다', () => {
    expect(bandLine(3_0000_0000, stats)).toBe('예상낙찰 1.80억~2.10억 (유사 14건 · 낙찰가율 중앙 64%)');
  });
  it('감정가 없음·표본 부족이면 null', () => {
    expect(bandLine(null, stats)).toBeNull();
    expect(bandLine(3_0000_0000, null)).toBeNull();
  });
});

describe('recentSalesLines', () => {
  it('최근 낙찰 사례를 최대 max건 라인으로', () => {
    const lines = recentSalesLines([
      { caseNo: 'a', address: '인천광역시 서구 크리스탈로10 어쩌구 저쩌구 긴 주소', date: '2026-07-09', soldAmount: 8000_0000, appraisal: 2_6000_0000 },
      { caseNo: 'b', address: '인천광역시 부평구 경인로110', date: '2026-07-08', soldAmount: 1_5000_0000, appraisal: 2_0000_0000 },
      { caseNo: 'c', address: '서울특별시 관악구 난곡로 298', date: '2026-07-07', soldAmount: 1_0000_0000, appraisal: 2_0000_0000 },
      { caseNo: 'd', address: '서울특별시 성북구', date: '2026-07-06', soldAmount: 1_0000_0000, appraisal: 2_0000_0000 },
    ], 3);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('2026-07-09 인천광역시 서구 크리스탈로10 어쩌구 → 낙찰 0.80억 (감정가 대비 31%)');
  });
});
