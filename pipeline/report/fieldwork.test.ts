import { describe, expect, it } from 'vitest';
import { buildFieldwork } from './fieldwork.ts';
import type { Listing, ListingReport, LocationAnalysis, RightsAnalysisResult } from '../../shared/types.ts';

const baseRights = (over: Partial<RightsAnalysisResult> = {}): RightsAnalysisResult => ({
  caseNo: '2024타경100',
  malsoBasis: { entry: null, date: '2023-01-01', note: '근저당' },
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
  ...over,
});

const makeMockReport = (over: Partial<ListingReport> = {}): ListingReport => ({
  headline: '테스트 보고서',
  recommendation: 'consider',
  summary: ['요약'],
  rightsSummary: '권리요약',
  locationSummary: '입지요약',
  costSummary: '비용요약',
  checklist: [],
  dangerCount: 0,
  warnCount: 0,
  legalRisk: { grade: 'manageable', manageable: true, headline: '양호', reasoning: '', factors: [] },
  ...over,
});

const baseLoc = (over: Partial<LocationAnalysis> = {}): LocationAnalysis => ({
  caseNo: '2024타경100',
  marketPrice: 300_000_000,
  comps: [],
  safetyMargin: 0.25,
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
    trueSafetyMargin: 0.24,
    notes: [],
  },
  income: {
    rentBasis: '실거래',
    jeonseDeposit: 150_000_000,
    monthlyDeposit: null,
    monthlyRent: null,
    jeonseRatioPct: 50,
    gapInvestment: 54_000_000,
    grossYieldPct: null,
    monthlyCashflow: null,
    cashflowNote: '',
    hiddenTenantDeposit: null,
    saleScenarios: [],
    notes: [],
  },
  eviction: {
    occupantLabel: '소유자 점유',
    remedy: 'WRIT',
    remedyLabel: '인도명령',
    writEligible: true,
    difficulty: 'easy',
    costLow: 1_000_000,
    costBase: 1_500_000,
    costHigh: 2_000_000,
    monthsLow: 1,
    monthsHigh: 3,
    reason: '인도명령 대상',
    negotiationBrief: '',
    laws: [],
    notes: [],
  },
  transit: { nearestStation: '역삼역', walkMinutes: 5 },
  report: makeMockReport(),
  ...over,
});

const baseListing = (over: Partial<Listing> = {}): Listing => ({
  caseNo: '2024타경100',
  itemNo: '1',
  court: '서울중앙지방법원',
  address: '서울특별시 강남구 역삼동 1-2',
  propertyType: 'apartment',
  appraisalValue: 300_000_000,
  minBidPrice: 200_000_000,
  failCount: 0,
  source: 'courtauction',
  crawledAt: '2026-06-22T00:00:00Z',
  isCollectiveBuilding: true,
  areaM2: 84.95,
  ...over,
});

describe('buildFieldwork', () => {
  it('기본 매물에 대해 원격 분석 완료 항목과 현장 체크리스트를 올바르게 구성한다', () => {
    const report = buildFieldwork(baseRights(), baseLoc(), baseListing());

    expect(report.remoteDone.every((r) => r.ok)).toBe(true);
    expect(report.legworkSavedPct).toBeGreaterThan(0);
    expect(report.legworkSavedPct).toBeLessThanOrEqual(100);

    const labels = report.fieldChecklist.map((f) => f.label);
    expect(labels).toContain('내부 상태(누수·곰팡이·결로·균열·새시)');
    expect(labels).toContain('실제 채광·향·전망');
    expect(labels).toContain('도보 접근(언덕·골목·주차)');
    expect(labels).toContain('주변 야간 소음·치안·분위기');
  });

  it('집합건물(아파트/다세대)이면 관리비 미납 확인 항목을 추가한다', () => {
    const collective = buildFieldwork(baseRights(), baseLoc(), baseListing({ isCollectiveBuilding: true }));
    expect(collective.fieldChecklist.some((f) => f.label.includes('미납 관리비'))).toBe(true);

    const nonCollective = buildFieldwork(baseRights(), baseLoc(), baseListing({ isCollectiveBuilding: false }));
    expect(nonCollective.fieldChecklist.some((f) => f.label.includes('미납 관리비'))).toBe(false);
  });

  it('명도 난이도가 easy가 아니거나 점유자 미상이면 점유자 실거주 확인 항목을 추가한다', () => {
    const locWithHardEviction = baseLoc({
      eviction: {
        occupantLabel: '대항력 임차인 점유',
        remedy: 'LAWSUIT',
        remedyLabel: '명도소송',
        writEligible: false,
        difficulty: 'hard',
        costLow: 3_000_000,
        costBase: 5_000_000,
        costHigh: 8_000_000,
        monthsLow: 6,
        monthsHigh: 12,
        reason: '명도소송 대상',
        negotiationBrief: '',
        laws: [],
        notes: [],
      },
    });
    const report = buildFieldwork(baseRights(), locWithHardEviction, baseListing());
    expect(report.fieldChecklist.some((f) => f.label.includes('점유자 실거주'))).toBe(true);
  });

  it('토지이용계획 risk 플래그가 있으면 현장 영향 확인 항목을 추가한다', () => {
    const locWithLandUse = baseLoc({
      landUseFlags: [
        { keyword: '군사', kind: 'risk', label: '군사보호구역', severity: 'high', impact: '통제보호구역 건축 제한' },
      ],
    });
    const report = buildFieldwork(baseRights(), locWithLandUse, baseListing());
    expect(report.fieldChecklist.some((f) => f.label.includes('군사보호구역 현장 영향'))).toBe(true);
  });

  it('체크리스트에 위반건축물이 있으면 현황 확인 항목을 추가한다', () => {
    const locWithViolation = baseLoc({
      report: makeMockReport({
        dangerCount: 1,
        warnCount: 0,
        checklist: [{
          id: 'illegal_building',
          label: '위반건축물(옥탑)',
          category: '물건하자',
          severity: 'danger',
          detail: '위반건축물 표기',
          source: '건축물대장',
          verify: '원상복구 여부 확인',
        }],
      }),
    });
    const report = buildFieldwork(baseRights(), locWithViolation, baseListing());
    expect(report.fieldChecklist.some((f) => f.label.includes('위반건축물'))).toBe(true);
  });

  it('40㎡ 미만 소형 빌라인 경우 반지하·저층 침수·습기 점검 항목을 추가한다', () => {
    const smallVilla = baseListing({
      propertyType: 'villa',
      address: '서울특별시 관악구 신림동 다세대',
      areaM2: 32.5,
    });
    const report = buildFieldwork(baseRights(), baseLoc(), smallVilla);
    expect(report.fieldChecklist.some((f) => f.label.includes('반지하·저층 침수'))).toBe(true);
  });
});
