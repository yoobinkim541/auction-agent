import { describe, it, expect } from 'vitest';
import { analyzeRights, findMalsoBasis, compareEntries } from './engine.ts';
import type { RightsInput, RegistryEntry, Tenant } from '../../shared/types.ts';

const 만 = 10_000;
const 억 = 100_000_000;

function makeInput(over: Partial<RightsInput> = {}): RightsInput {
  return {
    listing: {
      caseNo: '2024타경0001',
      court: '서울중앙지방법원',
      address: '서울특별시 강남구 역삼동 123',
      minBidPrice: 5 * 억,
      appraisalValue: 7 * 억,
      isCollectiveBuilding: true,
      ...(over.listing ?? {}),
    },
    registry: over.registry ?? [],
    tenants: over.tenants ?? [],
    landRegistry: over.landRegistry,
    statementSeniorDate: over.statementSeniorDate,
    notes: over.notes,
  };
}

function reg(kind: RegistryEntry['kind'], receiptDate: string, extra: Partial<RegistryEntry> = {}): RegistryEntry {
  return { kind, receiptDate, ...extra };
}
function tenant(over: Partial<Tenant> = {}): Tenant {
  return { deposit: 5000 * 만, demandedDistribution: false, occupied: true, ...over };
}

describe('정렬 / 말소기준권리', () => {
  it('접수일 → 접수번호 순으로 정렬', () => {
    const a = reg('geunjeodang', '2020-01-10', { receiptNo: 5 });
    const b = reg('geunjeodang', '2020-01-10', { receiptNo: 2 });
    expect(compareEntries(a, b)).toBeGreaterThan(0);
  });

  it('말소기준권리는 후보 중 최선순위 근저당', () => {
    const r = [
      reg('gaapryu', '2021-03-01'),
      reg('geunjeodang', '2019-06-15'),
      reg('geunjeodang', '2020-01-10'),
    ];
    const malso = findMalsoBasis(r);
    expect(malso?.receiptDate).toBe('2019-06-15');
  });

  it('가압류가 근저당보다 빠르면 가압류가 말소기준', () => {
    const r = [reg('geunjeodang', '2020-01-10'), reg('gaapryu', '2019-12-01')];
    expect(findMalsoBasis(r)?.kind).toBe('gaapryu');
  });

  it('후보가 없으면 null', () => {
    expect(findMalsoBasis([reg('jisangwon', '2020-01-01')])).toBeNull();
  });
});

describe('인수/소멸 분류', () => {
  const malsoR = reg('geunjeodang', '2020-06-01');

  it('근저당(금전권리)은 순위 무관 소멸', () => {
    const res = analyzeRights(makeInput({ registry: [malsoR, reg('geunjeodang', '2019-01-01')] }));
    const all = res.classified.filter((c) => c.entry.kind === 'geunjeodang');
    expect(all.every((c) => c.disposition === 'extinguished')).toBe(true);
  });

  it('선순위 지상권은 인수', () => {
    const res = analyzeRights(makeInput({ registry: [malsoR, reg('jisangwon', '2019-01-01')] }));
    const ji = res.classified.find((c) => c.entry.kind === 'jisangwon')!;
    expect(ji.disposition).toBe('assumed');
  });

  it('후순위 지상권은 소멸', () => {
    const res = analyzeRights(makeInput({ registry: [malsoR, reg('jisangwon', '2021-01-01')] }));
    const ji = res.classified.find((c) => c.entry.kind === 'jisangwon')!;
    expect(ji.disposition).toBe('extinguished');
  });

  it('건물철거 가처분은 순위 무관 인수', () => {
    const res = analyzeRights(makeInput({ registry: [malsoR, reg('cheolgeo_gacheobun', '2022-01-01')] }));
    const g = res.classified.find((c) => c.entry.kind === 'cheolgeo_gacheobun')!;
    expect(g.disposition).toBe('assumed');
  });

  it('선순위 전세권: 배당요구 없으면 인수, 있으면 소멸', () => {
    const noDemand = analyzeRights(makeInput({ registry: [malsoR, reg('jeonse', '2019-01-01', { amount: 3 * 억 })] }));
    expect(noDemand.classified.find((c) => c.entry.kind === 'jeonse')!.disposition).toBe('assumed');

    const demand = analyzeRights(makeInput({ registry: [malsoR, reg('jeonse', '2019-01-01', { amount: 3 * 억, demandedDistribution: true })] }));
    expect(demand.classified.find((c) => c.entry.kind === 'jeonse')!.disposition).toBe('extinguished');
  });
});

describe('임차인 대항력 — 익일 0시 규칙', () => {
  const malsoDate = '2020-01-10';
  const r = [reg('geunjeodang', malsoDate)];

  const cases: { name: string; moveIn: string; expect: boolean }[] = [
    { name: '전입 = 말소일 → 대항력 발생 익일 → 무대항력', moveIn: '2020-01-10', expect: false },
    { name: '전입 = 말소 전날 → 대항력일=말소일 → 대항력 있음', moveIn: '2020-01-09', expect: true },
    { name: '전입 = 말소 다음날 → 무대항력', moveIn: '2020-01-11', expect: false },
    { name: '전입이 훨씬 빠름 → 대항력 있음', moveIn: '2018-05-01', expect: true },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const res = analyzeRights(makeInput({
        registry: r,
        tenants: [tenant({ moveInDate: c.moveIn, occupancyDate: c.moveIn })],
      }));
      expect(res.tenants[0]!.hasOpposition).toBe(c.expect);
    });
  }

  it('점유 미확인이면 대항요건 불충족', () => {
    const res = analyzeRights(makeInput({ registry: r, tenants: [tenant({ moveInDate: '2018-01-01', occupied: false })] }));
    expect(res.tenants[0]!.hasOpposition).toBe(false);
  });

  it('말소기준권리 없으면 대항요건 갖춘 임차인은 대항력 있음', () => {
    const res = analyzeRights(makeInput({ registry: [reg('jisangwon', '2021-01-01')], tenants: [tenant({ moveInDate: '2020-01-01', occupancyDate: '2020-01-01' })] }));
    expect(res.tenants[0]!.hasOpposition).toBe(true);
  });
});

describe('우선변제권 / 소액임차인', () => {
  it('확정일자 있으면 우선변제권', () => {
    const res = analyzeRights(makeInput({
      registry: [reg('geunjeodang', '2024-01-01')],
      tenants: [tenant({ moveInDate: '2024-02-01', occupancyDate: '2024-02-01', fixedDate: '2024-02-01' })],
    }));
    expect(res.tenants[0]!.hasPriorityRepayment).toBe(true);
  });

  it('서울 2023년 기준: 보증금 1.6억은 소액임차인(상한 1.65억)', () => {
    const res = analyzeRights(makeInput({
      registry: [reg('geunjeodang', '2024-01-01')],
      tenants: [tenant({ deposit: 16000 * 만, moveInDate: '2024-02-01', occupancyDate: '2024-02-01' })],
    }));
    expect(res.tenants[0]!.isSmallTenant).toBe(true);
    expect(res.tenants[0]!.minPriorityAmount).toBe(5500 * 만);
  });

  it('서울 기준 초과 보증금(2억)은 소액임차인 아님', () => {
    const res = analyzeRights(makeInput({
      registry: [reg('geunjeodang', '2024-01-01')],
      tenants: [tenant({ deposit: 2 * 억, moveInDate: '2024-02-01', occupancyDate: '2024-02-01' })],
    }));
    expect(res.tenants[0]!.isSmallTenant).toBe(false);
    expect(res.tenants[0]!.minPriorityAmount).toBe(0);
  });

  it('소액임차인 기준은 근저당(담보물권) 설정일 기준 — 2015년 설정이면 옛 기준 적용', () => {
    // 2014-01-01~2016-03-30 서울 상한 9500만. 보증금 1억은 소액 아님(당시 기준).
    const res = analyzeRights(makeInput({
      registry: [reg('geunjeodang', '2015-05-01')],
      tenants: [tenant({ deposit: 1 * 억, moveInDate: '2016-01-01', occupancyDate: '2016-01-01' })],
    }));
    expect(res.tenants[0]!.isSmallTenant).toBe(false);
  });
});

describe('인수금액 / 위험등급', () => {
  it('선순위 대항력 임차인 + 배당요구 없음 → 보증금 전액 인수, risky', () => {
    const res = analyzeRights(makeInput({
      registry: [reg('geunjeodang', '2021-01-01')],
      tenants: [tenant({ deposit: 3 * 억, moveInDate: '2019-01-01', occupancyDate: '2019-01-01', demandedDistribution: false })],
    }));
    expect(res.assumedAmount).toBe(3 * 억);
    expect(res.isClean).toBe(false);
    expect(['risky', 'review_required']).toContain(res.riskGrade);
  });

  it('후순위 임차인은 인수 0', () => {
    const res = analyzeRights(makeInput({
      registry: [reg('geunjeodang', '2019-01-01')],
      tenants: [tenant({ deposit: 3 * 억, moveInDate: '2021-01-01', occupancyDate: '2021-01-01' })],
    }));
    expect(res.assumedAmount).toBe(0);
  });

  it('권리 깨끗한 매물(임차인 없음, 근저당만) → clean & 인수 0', () => {
    const res = analyzeRights(makeInput({ registry: [reg('geunjeodang', '2020-01-01'), reg('gyeongmae_gaesi', '2024-01-01')] }));
    expect(res.assumedAmount).toBe(0);
    expect(res.isClean).toBe(true);
    expect(res.riskGrade).toBe('clean');
  });
});

describe('레드플래그', () => {
  it('비고에 유치권 → danger + 사람 검토', () => {
    const res = analyzeRights(makeInput({ registry: [reg('geunjeodang', '2020-01-01')], notes: ['유치권 신고 있음(공사대금)'] }));
    const f = res.redFlags.find((x) => x.kind === 'yuchigwon');
    expect(f?.severity).toBe('danger');
    expect(f?.needsHumanReview).toBe(true);
    expect(res.riskGrade).toBe('review_required');
  });

  it('대지권 미등기 → review_required', () => {
    const res = analyzeRights(makeInput({ registry: [reg('geunjeodang', '2020-01-01')], notes: ['대지권 미등기'] }));
    expect(res.riskGrade).toBe('review_required');
  });

  it('선순위 대항력 임차인 → senior_tenant 플래그', () => {
    const res = analyzeRights(makeInput({
      registry: [reg('geunjeodang', '2021-01-01')],
      tenants: [tenant({ moveInDate: '2019-01-01', occupancyDate: '2019-01-01' })],
    }));
    expect(res.redFlags.some((f) => f.kind === 'senior_tenant')).toBe(true);
  });
});

describe('analyzeRights — 보증금 파싱 실패', () => {
  it('임차인 보증금 파싱 실패는 사람 검토로 올리고 클린으로 판정하지 않는다', () => {
    const res = analyzeRights(makeInput({ tenants: [tenant({ moveInDate: '2020-01-01', occupancyDate: '2020-01-01', depositParseFailed: true })] }));
    expect(res.riskGrade).toBe('review_required');
    expect(res.warnings.some((w) => w.includes('보증금 파싱 실패'))).toBe(true);
  });
});
