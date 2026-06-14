import { describe, it, expect } from 'vitest';
import { evaluateCase, runEval } from './harness.ts';
import type { SolvedCase } from './types.ts';

const 억 = 100_000_000;

const cleanCase: SolvedCase = {
  id: 'CLEAN-1', source: 'manual',
  input: {
    listing: { caseNo: 'CLEAN-1', court: '서울중앙', address: '서울특별시 송파구', minBidPrice: 8 * 억, appraisalValue: 11 * 억, isCollectiveBuilding: true },
    registry: [{ kind: 'geunjeodang', receiptDate: '2019-03-10', amount: 6 * 억 }, { kind: 'gyeongmae_gaesi', receiptDate: '2024-02-01' }],
    tenants: [],
  },
  expected: { malsoDate: '2019-03-10', assumedAmount: 0, isClean: true },
};

const seniorTenantCase: SolvedCase = {
  id: 'SENIOR-1', source: 'manual',
  input: {
    listing: { caseNo: 'SENIOR-1', court: '수원', address: '경기도 수원시', minBidPrice: 4 * 억, appraisalValue: 5 * 억, isCollectiveBuilding: true },
    registry: [{ kind: 'geunjeodang', receiptDate: '2021-05-01', amount: 2 * 억 }],
    tenants: [{ deposit: 3 * 억, moveInDate: '2019-01-01', occupancyDate: '2019-01-01', demandedDistribution: false, occupied: true }],
  },
  expected: { malsoDate: '2021-05-01', assumedAmount: 3 * 억, isClean: false, tenantOpposition: [true] },
};

describe('eval harness', () => {
  it('정확한 정답 라벨은 전부 통과', () => {
    const rep = runEval([cleanCase, seniorTenantCase]);
    expect(rep.caseAccuracy).toBe(1);
    expect(rep.passedCases).toBe(2);
  });

  it('필드별 정확도 집계 (tenant[] 병합)', () => {
    const rep = runEval([cleanCase, seniorTenantCase]);
    expect(rep.fieldAccuracy['assumedAmount']!.n).toBe(2);
    expect(rep.fieldAccuracy['tenant[].hasOpposition']!.ok).toBe(1);
  });

  it('틀린 정답 라벨은 실패로 검출(채점기 자체 검증)', () => {
    const wrong: SolvedCase = { ...cleanCase, id: 'WRONG-1', expected: { assumedAmount: 999 } };
    const res = evaluateCase(wrong);
    expect(res.pass).toBe(false);
    expect(res.fields[0]!.ok).toBe(false);
  });
});
