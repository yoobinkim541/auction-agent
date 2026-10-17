import { describe, it, expect } from 'vitest';
import { decideRecommendation, buildReport } from './build.ts';
import type { Listing, LocationAnalysis, RightsAnalysisResult } from '../../shared/types.ts';
type Input = Parameters<typeof decideRecommendation>[0];
const base: Input = { dataComplete: true, assumedAmount: 0, dangerCount: 0, warnCount: 0, riskGrade: 'clean', trueMargin: 0.3 };
const rec = (o: Partial<Input>) => decideRecommendation({ ...base, ...o });

describe('decideRecommendation', () => {
  it('데이터 불완전 → caution(다른 조건 무관)', () => {
    expect(rec({ dataComplete: false, assumedAmount: 999, dangerCount: 9 })).toBe('caution');
  });

  it('avoid: 인수금액>0 / danger / review_required / 음수마진', () => {
    expect(rec({ assumedAmount: 1 })).toBe('avoid');
    expect(rec({ dangerCount: 1 })).toBe('avoid');
    expect(rec({ riskGrade: 'review_required' })).toBe('avoid');
    expect(rec({ trueMargin: -0.01 })).toBe('avoid');
  });

  it('caution: warn / 저마진(<10%) / risky·caution 등급', () => {
    expect(rec({ warnCount: 1 })).toBe('caution');
    expect(rec({ trueMargin: 0.05 })).toBe('caution');
    expect(rec({ riskGrade: 'risky' })).toBe('caution');
    expect(rec({ riskGrade: 'caution' })).toBe('caution');
  });

  it('consider: 깨끗 + 여유마진', () => {
    expect(rec({})).toBe('consider');
    expect(rec({ trueMargin: null })).toBe('consider'); // null은 저마진 아님
    expect(rec({ trueMargin: 0.1 })).toBe('consider');  // 경계: <0.1 아님
  });

  it('우선순위: avoid가 caution보다 먼저(인수 있으면 warn 있어도 avoid)', () => {
    expect(rec({ assumedAmount: 1, warnCount: 5 })).toBe('avoid');
  });
});

describe('buildReport', () => {
  const malsoEntry = {
    rankNo: 1,
    kind: 'geunjeodang' as const,
    receiptDate: '2023-01-01',
    receiptNo: 12345,
    claimant: '우리은행',
    amount: 100_000_000,
  };
  const rights: RightsAnalysisResult = {
    caseNo: '2024타경200',
    malsoBasis: { entry: malsoEntry, date: '2023-01-01', note: '근저당권' },
    classified: [],
    tenants: [],
    distribution: [],
    assumedAmount: 0,
    assumedBreakdown: [],
    maxSafeBid: null,
    redFlags: [],
    riskGrade: 'clean',
    isClean: true,
    warnings: [],
    engineVersion: '0.1.0',
  };

  const loc: LocationAnalysis = {
    caseNo: '2024타경200',
    marketPrice: 300_000_000,
    comps: [],
    safetyMargin: 0.33,
    acquisitionCost: {
      bidPrice: 200_000_000,
      bidBasis: '최저가',
      acqTax: 2_200_000,
      acqTaxRatePct: 1.1,
      moveOutCost: 1_500_000,
      bondCost: 300_000,
      assumedAmount: 0,
      etcCost: 0,
      totalCost: 204_000_000,
      trueSafetyMargin: 0.32,
      notes: [],
    },
  };

  const listing: Listing = {
    caseNo: '2024타경200',
    itemNo: '1',
    court: '서울중앙지방법원',
    address: '서울특별시 강남구 역삼동 100',
    propertyType: 'apartment',
    appraisalValue: 300_000_000,
    minBidPrice: 200_000_000,
    failCount: 0,
    source: 'courtauction',
    crawledAt: '2026-06-22T00:00:00Z',
    sourceUrl: 'https://courtauction.go.kr/detail/200',
    isCollectiveBuilding: true,
  };

  it('dataComplete가 false면 데이터 불완전 헤드라인과 권리분석 보류를 반환한다', () => {
    const report = buildReport({
      rights,
      loc,
      listing,
      notes: [],
      scanText: '',
      dataComplete: false,
    });

    expect(report.recommendation).toBe('caution');
    expect(report.headline).toContain('[데이터 불완전]');
    expect(report.rightsSummary).toContain('등기 미수집');
    expect(report.sourceUrl).toBe(listing.sourceUrl);
    expect(report.fieldwork).toBeDefined();
  });

  it('정상 데이터에서 종합 보고서의 헤드라인·요약·체크리스트가 올바르게 조립된다', () => {
    const report = buildReport({
      rights,
      loc,
      listing,
      notes: [],
      scanText: '',
    });

    expect(report.recommendation).toBe('consider');
    expect(report.headline).toContain('[검토 권장]');
    expect(report.headline).toContain('시세 3.00억');
    expect(report.headline).toContain('최저가 2.00억');
    expect(report.headline).toContain('안전마진 33.0%');
    expect(report.headline).toContain('진짜마진 32.0%');
    expect(report.headline).toContain('인수 없음');
    expect(report.dangerCount).toBe(0);
  });

  it('임차인 보증금 파싱 실패가 있으면 헤드라인에 인수금액 미확인을 표기한다', () => {
    const failedRights: RightsAnalysisResult = {
      ...rights,
      tenants: [
        {
          tenant: { deposit: 0, depositParseFailed: true, occupied: true, demandedDistribution: false },
          oppositionDate: null,
          hasOpposition: false,
          hasPriorityRepayment: false,
          priorityDate: null,
          isSmallTenant: false,
          minPriorityAmount: 0,
          validDemand: false,
          notes: [],
        },
      ],
    };

    const report = buildReport({
      rights: failedRights,
      loc,
      listing,
      notes: [],
      scanText: '',
    });

    expect(report.headline).toContain('인수금액 미확인');
  });
});
