import { describe, expect, it } from 'vitest';
import { emptyRetryCounters, statusFromRounds, toCourtCaseNo, toCourtItemNo } from './outcome-retry-utils.ts';
import type { SaleResultRound } from '../crawler/adapters/courtauction.ts';

describe('outcome retry helpers', () => {
  it('converts normalized numeric case numbers to courtauction 타경 format', () => {
    expect(toCourtCaseNo('2025-103154')).toBe('2025타경103154');
  });

  it('keeps existing 타경 case numbers unchanged after normalization', () => {
    expect(toCourtCaseNo('2025타경103154')).toBe('2025타경103154');
  });

  it('normalizes invalid item numbers to the default 물건번호 1', () => {
    expect(toCourtItemNo(null)).toBe('1');
    expect(toCourtItemNo('')).toBe('1');
    expect(toCourtItemNo('0')).toBe('1');
    expect(toCourtItemNo('-2')).toBe('1');
  });

  it('keeps positive item numbers as strings', () => {
    expect(toCourtItemNo(' 3 ')).toBe('3');
  });

  it('classifies retry status from collected rounds', () => {
    const rounds: SaleResultRound[] = [{ date: '2026-07-01', kindCd: '01', resultCd: '002', minPrice: 100, soldAmount: null, sold: false }];
    expect(statusFromRounds(rounds)).toBe('success');
    expect(statusFromRounds([])).toBe('empty');
  });

  it('creates zeroed retry counters', () => {
    expect(emptyRetryCounters()).toEqual({ processed: 0, success: 0, empty: 0, blocked: 0, error: 0, skipped: 0 });
  });
});
