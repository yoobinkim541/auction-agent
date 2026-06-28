import { describe, it, expect } from 'vitest';
import { parseSaleResults } from './courtauction.ts';

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
