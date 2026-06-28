import { describe, it, expect } from 'vitest';
import { parseSaleResults, nextSaleDate, failedRoundCount, type SaleResultRound } from './courtauction.ts';

describe('parseSaleResults', () => {
  it('gdsDspslDxdyLst → 회차별 결과(유찰/매각) 파싱', () => {
    const dma = {
      gdsDspslDxdyLst: [
        { dxdyYmd: '20260414', auctnDxdyKndCd: '01', auctnDxdyRsltCd: '002', tsLwsDspslPrc: 2565337200, dspslAmt: null }, // 유찰
        { dxdyYmd: '20260526', auctnDxdyKndCd: '01', auctnDxdyRsltCd: '001', tsLwsDspslPrc: 2052269760, dspslAmt: 2300000000 }, // 매각
        { dxdyYmd: '', auctnDxdyKndCd: '01', auctnDxdyRsltCd: null, tsLwsDspslPrc: 0, dspslAmt: 0 }, // 날짜없음 → 제외
      ],
    };
    const r = parseSaleResults(dma);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ date: '2026-04-14', resultCd: '002', minPrice: 2565337200, sold: false, soldAmount: null });
    expect(r[1]).toMatchObject({ date: '2026-05-26', sold: true, soldAmount: 2300000000 });
  });

  it('빈/누락 입력 → 빈 배열', () => {
    expect(parseSaleResults(null)).toEqual([]);
    expect(parseSaleResults({})).toEqual([]);
    expect(parseSaleResults({ gdsDspslDxdyLst: [] })).toEqual([]);
  });
});

const round = (o: Partial<SaleResultRound>): SaleResultRound => ({
  date: '2026-01-01', kindCd: '01', resultCd: null, minPrice: 1e8, soldAmount: null, sold: false, ...o,
});

describe('nextSaleDate / failedRoundCount', () => {
  const rounds = [
    round({ date: '2026-04-14', resultCd: '002', minPrice: 2.5e8 }), // 과거 유찰
    round({ date: '2026-05-26', resultCd: '002', minPrice: 2.0e8 }), // 과거 유찰
    round({ date: '2026-07-07', minPrice: 1.6e8 }),                  // 예정 매각기일
    round({ date: '2026-07-14', kindCd: '02', minPrice: 0 }),        // 매각결정기일(제외)
  ];

  it('다음 매각기일 = 오늘 이후 kind 01 중 최이른', () => {
    expect(nextSaleDate(rounds, '2026-06-28')).toEqual({ date: '2026-07-07', minPrice: 1.6e8 });
  });
  it('유찰 횟수 = 과거 미낙찰 매각기일 수', () => {
    expect(failedRoundCount(rounds, '2026-06-28')).toBe(2);
  });
  it('매각(sold)되면 다음 기일 없음 → null', () => {
    const soldRounds = [round({ date: '2026-05-26', sold: true, soldAmount: 2.3e8 })];
    expect(nextSaleDate(soldRounds, '2026-06-28')).toBeNull();
  });
  it('예정 기일 없으면 null', () => {
    expect(nextSaleDate([round({ date: '2026-04-14', resultCd: '002' })], '2026-06-28')).toBeNull();
  });
});
