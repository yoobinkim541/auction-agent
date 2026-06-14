/**
 * 더낙찰옥션 'chart12.html'(주택임대차보호법상 임차인 권리보호 12사례)을 fixture로
 * 엔진의 대항력/우선변제권 판정이 권위 있는 참고표와 일치하는지 검증한다.
 *
 * 모델링: 말소기준권리(근저당) = 2020-06-01.
 *   "기준 이전" = 2019년, "기준 이후" = 2021년 날짜로 사건 선후를 표현.
 *   대항력 = 인도(점유)+전입이 모두 기준보다 앞설 때(익일 0시 규칙).
 *   우선변제권 = 대항요건(점유+전입) + 확정일자.
 *   ※ G(전입 후 점유): 점유일이 기준보다 늦어 대항력 없음(엔진은 보수적으로 무대항력).
 *   ※ F(재전입): 나중 전입일이 기준 이후 → moveInDate에 나중 전입일을 넣어 대항력 소실 반영.
 */
import { describe, it, expect } from 'vitest';
import { analyzeRights } from './engine.ts';
import type { RightsInput, Tenant } from '../../shared/types.ts';

const 억 = 100_000_000;
const MALSO = '2020-06-01';
const BEFORE = '2019-01-01';
const BEFORE2 = '2019-02-01';
const AFTER = '2021-01-01';
const AFTER2 = '2021-01-02';
const AFTER3 = '2021-01-03';

function run(t: Partial<Tenant>) {
  const input: RightsInput = {
    listing: { caseNo: 'chart12', court: '', address: '서울특별시 강남구', minBidPrice: 5 * 억, appraisalValue: 7 * 억, isCollectiveBuilding: true },
    registry: [{ kind: 'geunjeodang', receiptDate: MALSO, amount: 3 * 억 }],
    tenants: [{ deposit: 3 * 억, demandedDistribution: true, occupied: true, ...t }],
  };
  return analyzeRights(input).tenants[0]!;
}

interface Case { label: string; t: Partial<Tenant>; opposition: boolean; priority: boolean }

// 표의 각 사례를 날짜 선후로 인코딩
const CASES: Case[] = [
  { label: 'A 인도→전입 (기준 전, 확정 없음)', t: { occupancyDate: BEFORE, moveInDate: BEFORE2 }, opposition: true, priority: false },
  { label: 'B 인도→전입→확정 (모두 기준 전)', t: { occupancyDate: BEFORE, moveInDate: BEFORE2, fixedDate: '2019-03-01' }, opposition: true, priority: true },
  { label: 'C 인도→전입→확정(다소 늦게, 기준 전)', t: { occupancyDate: BEFORE, moveInDate: BEFORE2, fixedDate: '2019-05-01' }, opposition: true, priority: true },
  { label: 'D 인도(전)→전입(기준 후), 확정 없음', t: { occupancyDate: BEFORE, moveInDate: AFTER }, opposition: false, priority: false },
  { label: 'E 인도(전)→전입(후)→확정', t: { occupancyDate: BEFORE, moveInDate: AFTER, fixedDate: AFTER2 }, opposition: false, priority: true },
  { label: 'F 재전입(나중 전입 기준 후)', t: { occupancyDate: AFTER, moveInDate: AFTER, fixedDate: BEFORE }, opposition: false, priority: true },
  { label: 'G 전입(전)→기준→인도(후), 확정 없음', t: { moveInDate: BEFORE, occupancyDate: AFTER }, opposition: false, priority: false },
  { label: 'H 전입(전)→기준→인도(후)→확정', t: { moveInDate: BEFORE, occupancyDate: AFTER, fixedDate: AFTER2 }, opposition: false, priority: true },
  { label: 'I 기준→전입→확정→인도', t: { moveInDate: AFTER, fixedDate: AFTER2, occupancyDate: AFTER3 }, opposition: false, priority: true },
  { label: 'J 기준→인도→전입 (확정 없음)', t: { occupancyDate: AFTER, moveInDate: AFTER2 }, opposition: false, priority: false },
  { label: 'K 기준→인도→전입→확정', t: { occupancyDate: AFTER, moveInDate: AFTER2, fixedDate: AFTER3 }, opposition: false, priority: true },
];

describe('chart12 — 임차인 권리보호 12사례 대조', () => {
  for (const c of CASES) {
    it(c.label, () => {
      const r = run(c.t);
      expect(r.hasOpposition, '대항력').toBe(c.opposition);
      expect(r.hasPriorityRepayment, '우선변제권').toBe(c.priority);
    });
  }

  it('점유 없이 전입만 있으면(서류상) 대항력 없음 (G 변형)', () => {
    const r = run({ moveInDate: BEFORE, occupied: false });
    expect(r.hasOpposition).toBe(false);
  });
});
