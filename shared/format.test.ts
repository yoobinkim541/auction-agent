import { describe, expect, it } from 'vitest';
import { EOK, MANWON, eok, manwonToWon, pct, won } from './format.ts';

describe('shared/format', () => {
  describe('상수 EOK, MANWON', () => {
    it('1억은 100,000,000이다', () => {
      expect(EOK).toBe(100_000_000);
    });

    it('1만은 10,000이다', () => {
      expect(MANWON).toBe(10_000);
    });
  });

  describe('won', () => {
    it('원 단위 금액을 쉼표와 함께 한글 포맷팅한다', () => {
      expect(won(0)).toBe('0원');
      expect(won(1234000)).toBe('1,234,000원');
      expect(won(100_000_000)).toBe('100,000,000원');
    });
  });

  describe('eok', () => {
    it('금액을 억 단위 소수점 둘째자리로 포맷팅한다', () => {
      expect(eok(100_000_000)).toBe('1.00억');
      expect(eok(250_000_000)).toBe('2.50억');
      expect(eok(12_345_678)).toBe('0.12억');
      expect(eok(0)).toBe('0.00억');
    });

    it('null 또는 undefined 입력 시 "-"를 반환한다', () => {
      expect(eok(null)).toBe('-');
      expect(eok(undefined)).toBe('-');
    });
  });

  describe('pct', () => {
    it('비율(0~1)을 백분율(소수점 첫째자리)로 포맷팅한다', () => {
      expect(pct(0.123)).toBe('12.3%');
      expect(pct(0.25)).toBe('25.0%');
      expect(pct(0)).toBe('0.0%');
      expect(pct(1)).toBe('100.0%');
      expect(pct(-0.05)).toBe('-5.0%');
    });

    it('null 또는 undefined 입력 시 "-"를 반환한다', () => {
      expect(pct(null)).toBe('-');
      expect(pct(undefined)).toBe('-');
    });
  });

  describe('manwonToWon', () => {
    it('만원 단위 숫자를 원 단위로 변환한다', () => {
      expect(manwonToWon(0)).toBe(0);
      expect(manwonToWon(100)).toBe(1_000_000);
      expect(manwonToWon(5000)).toBe(50_000_000);
      expect(manwonToWon(10_000)).toBe(100_000_000);
    });
  });
});
