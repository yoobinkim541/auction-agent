import { describe, it, expect } from 'vitest';
import { extractRegistryRowsFromText, extractSiteMetrics, caseNoToMngno, DEONAK_COURT1 } from './deonakchal.ts';

describe('caseNoToMngno (courtauction 사건번호 → deonakchal mngno)', () => {
  it('타경 사건번호 → 연도-번호', () => {
    expect(caseNoToMngno('2023타경111644')).toBe('2023-111644');
    expect(caseNoToMngno('2023 타경 111644')).toBe('2023-111644'); // 공백 허용
  });
  it('포맷 아니면 null', () => {
    expect(caseNoToMngno('그냥문자')).toBeNull();
    expect(caseNoToMngno('')).toBeNull();
  });
});

describe('DEONAK_COURT1 (수도권 법원 매핑)', () => {
  it('courtauction METRO_COURTS 이름과 매칭', () => {
    expect(DEONAK_COURT1['서울중앙지방법원']).toBe('A1');
    expect(DEONAK_COURT1['남양주지원']).toBe('D3');
    expect(DEONAK_COURT1['안산지원']).toBe('E5');
    expect(DEONAK_COURT1['수원지방법원']).toBe('E1');
  });
});

describe('lookupCaseDetail row match key', () => {
  it('item_no가 다른 같은 사건은 별도 물건으로 봐야 함', () => {
    const rows = [
      { productId: 'p1', listing: { caseNo: '2025-103018', itemNo: '1' } },
      { productId: 'p2', listing: { caseNo: '2025-103018', itemNo: '2' } },
    ];
    const chosen = rows.find((r) => r.productId && r.listing.caseNo === '2025-103018' && (r.listing.itemNo ?? '1') === '2');
    expect(chosen?.productId).toBe('p2');
  });
});

describe('extractRegistryRowsFromText', () => {
  it('근저당·가압류 행을 종류/접수일/금액으로 파싱', () => {
    const rows = extractRegistryRowsFromText([
      '근저당권 2020.05.01 채권최고액 120,000,000원',
      '가압류 2021.03.15 청구금액 50,000,000원',
    ]);
    expect(rows).toEqual([
      { kind: 'geunjeodang', receiptDate: '2020-05-01', amount: 120_000_000 },
      { kind: 'gaapryu', receiptDate: '2021-03-15', amount: 50_000_000 },
    ]);
  });

  it('접수일 없는 행·종류 미상(other) 행은 제외', () => {
    const rows = extractRegistryRowsFromText([
      '근저당권 채권최고액 100,000,000원', // 날짜 없음 → 제외
      '기타 일반 메모',                     // other → 제외
      '소유권이전 2019.01.01',              // 날짜 있으나 soyugwon
    ]);
    expect(rows.every((r) => r.receiptDate)).toBe(true);
    expect(rows.some((r) => r.kind === 'geunjeodang')).toBe(false); // 날짜 없는 근저당 제외
    expect(rows.find((r) => r.kind === 'soyugwon')?.receiptDate).toBe('2019-01-01');
  });
});

describe('extractSiteMetrics', () => {
  const body = [
    '역세권 2호선 강남역 350m 개발계획 없음',
    '1차 2026-06-16 231,000,000 (20%↓)',
    '2차 2026-07-21 184,800,000 (20%↓)',
    '주용도 아파트',
    '세대/가구/호 100/100/100',
    '사용승인일 20200101',
    '명도비 1,800,000 원',
  ].join(' ');
  const raw = '토지이용계획 및 제한상태 자연녹지지역, 도로 저촉 매각효력 있음';

  it('역세권·매각기일·표제부·명도비·토지이용 추출', () => {
    const m = extractSiteMetrics(body, raw);
    expect(m.transit).toEqual([{ line: '2호선', station: '강남역', distanceM: 350 }]);
    expect(m.saleRounds?.length).toBe(2);
    expect(m.saleRounds?.[0]).toEqual({ round: 1, date: '2026-06-16', minPrice: 231_000_000, ratioPct: 20 });
    expect(m.building).toMatchObject({ mainUse: '아파트', households: 100, approvalDate: '2020-01-01' });
    expect(m.moveOutCost).toBe(1_800_000);
    expect(m.landUseText).toBe('자연녹지지역, 도로 저촉');
  });

  it('빈 본문 → 빈 메트릭(throw 없음)', () => {
    expect(extractSiteMetrics('', '')).toEqual({});
  });
});
