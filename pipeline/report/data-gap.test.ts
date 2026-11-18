import { describe, it, expect } from 'vitest';
import { detectDataGap } from './data-gap.ts';

const empty = { docCount: 2, registryCount: 0, tenantCount: 0, siteAssumed: null };

describe('detectDataGap', () => {
  it('최선순위설정·임차인·사이트 인수금액 중 하나라도 있으면 공백이 아니다', () => {
    expect(detectDataGap({ ...empty, registryCount: 1 })).toBeNull();
    expect(detectDataGap({ ...empty, tenantCount: 1 })).toBeNull();
    expect(detectDataGap({ ...empty, siteAssumed: 0 })).toBeNull();
    // 문서가 없어도 교차보강 임차인이 있으면 분석 가능
    expect(detectDataGap({ ...empty, docCount: 0, tenantCount: 1 })).toBeNull();
  });

  it('문서가 하나도 없으면 미수집', () => {
    expect(detectDataGap({ ...empty, docCount: 0, saleDate: '2026-11-30' })).toBe('no_docs');
  });

  it('매각 14일보다 일찍 받은 빈 명세서는 공개 전 수집', () => {
    expect(detectDataGap({ ...empty, saleDate: '2026-11-30', docsFetchedAt: new Date('2026-11-15T03:00:00Z') })).toBe('statement_pending');
  });

  it('매각 14일 이내에 받았는데도 비어 있으면 기재 없음', () => {
    expect(detectDataGap({ ...empty, saleDate: '2026-11-30', docsFetchedAt: new Date('2026-11-16T03:00:00Z') })).toBe('statement_blank');
    expect(detectDataGap({ ...empty, saleDate: '2026-11-30', docsFetchedAt: new Date('2026-11-29T03:00:00Z') })).toBe('statement_blank');
  });

  it('수집일은 KST 날짜로 센다 — UTC 21시 배치는 한국 다음 날 수집', () => {
    // 2026-11-15 21:00 UTC = 11-16 06:00 KST → 11-30 매각의 14일 전(공개 창 안)
    expect(detectDataGap({ ...empty, saleDate: '2026-11-30', docsFetchedAt: new Date('2026-11-15T21:00:00Z') })).toBe('statement_blank');
  });

  it('매각기일이 Date(DB DATE 컬럼의 런타임 값)여도 같은 날짜로 센다', () => {
    const sale = new Date(2026, 10, 30); // 로컬 자정 2026-11-30
    expect(detectDataGap({ ...empty, saleDate: sale, docsFetchedAt: new Date('2026-11-15T03:00:00Z') })).toBe('statement_pending');
    expect(detectDataGap({ ...empty, saleDate: sale, docsFetchedAt: new Date('2026-11-16T03:00:00Z') })).toBe('statement_blank');
  });

  it('기일 미정이면 공개 전으로 본다', () => {
    expect(detectDataGap({ ...empty, docsFetchedAt: new Date('2026-11-15T03:00:00Z') })).toBe('statement_pending');
  });
});
