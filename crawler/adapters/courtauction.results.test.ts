import { describe, it, expect } from 'vitest';
import { parseSaleResults, nextSaleDate, failedRoundCount, parseCaseResult, courtCodeByName, type SaleResultRound } from './courtauction.ts';

describe('courtCodeByName', () => {
  it('담당계가 붙은 DB 법원명도 본원/지원 코드로 매핑', () => {
    expect(courtCodeByName('인천8계')).toBe('B000240');
    expect(courtCodeByName('고양3계')).toBe('B214807');
    expect(courtCodeByName('서울북부1계')).toBe('B000213');
    expect(courtCodeByName('성남9계')).toBe('B000251');
  });
});

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

describe('parseCaseResult (pgj15A 경매사건검색)', () => {
  const data = {
    dlt_dspslGdsDspslObjctLst: [
      { dspslGdsSeq: '1', dspslAmt: 477000000, fstPbancLwsDspslPrc: 416500000, scndPbancLwsDspslPrc: 333200000 },
      { dspslGdsSeq: '2', dspslAmt: 0, fstPbancLwsDspslPrc: 200000000 },
    ],
    dlt_rletCsGdsDtsDxdyInf: [
      { dspslGdsSeq: '1', auctnDxdyKndCd: '01', dxdyYmd: '20260520', auctnDxdyRsltCd: '002' }, // 유찰
      { dspslGdsSeq: '1', auctnDxdyKndCd: '01', dxdyYmd: '20260625', auctnDxdyRsltCd: '001' }, // 매각
      { dspslGdsSeq: '1', auctnDxdyKndCd: '02', dxdyYmd: '20260702', auctnDxdyRsltCd: null },  // 매각결정
      { dspslGdsSeq: '2', auctnDxdyKndCd: '01', dxdyYmd: '20260625', auctnDxdyRsltCd: '002' }, // 다른 물건
    ],
  };

  it('물건1: 유찰→매각, 낙찰가·차수별 최저가 부착', () => {
    const r = parseCaseResult(data, '1');
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ date: '2026-05-20', resultCd: '002', minPrice: 416500000, sold: false, soldAmount: null });
    expect(r[1]).toMatchObject({ date: '2026-06-25', resultCd: '001', minPrice: 333200000, sold: true, soldAmount: 477000000 });
    expect(r[2]).toMatchObject({ kindCd: '02', sold: false, minPrice: null });
  });

  it('물건2만 필터(다물건 분리)', () => {
    const r = parseCaseResult(data, '2');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ date: '2026-06-25', resultCd: '002', minPrice: 200000000, sold: false });
  });

  it('빈 입력 안전', () => {
    expect(parseCaseResult(null)).toEqual([]);
    expect(parseCaseResult({})).toEqual([]);
  });
});
