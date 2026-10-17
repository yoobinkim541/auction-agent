import { describe, expect, it } from 'vitest';
import {
  bidBoxDigits,
  numberToKoreanHangeulAmount,
  requiredBidDocuments,
  validateBidAmount,
} from './bid-sheet.ts';

describe('shared/bid-sheet', () => {
  describe('numberToKoreanHangeulAmount (금액 한글 표기 변환)', () => {
    it('억 단위와 만 단위를 정확한 한글 독음으로 변환한다', () => {
      expect(numberToKoreanHangeulAmount(235_000_000)).toBe('이억 삼천오백만 원');
      expect(numberToKoreanHangeulAmount(150_000_000)).toBe('일억 오천만 원');
      expect(numberToKoreanHangeulAmount(50_000_000)).toBe('오천만 원');
      expect(numberToKoreanHangeulAmount(1_234_560_000)).toBe('십이억 삼천사백오십육만 원');
    });

    it('0원은 "영 원"으로 반환한다', () => {
      expect(numberToKoreanHangeulAmount(0)).toBe('영 원');
    });
  });

  describe('bidBoxDigits (기일입찰표 12개 칸별 숫자 분해)', () => {
    it('금액을 기일입찰표 자릿수 칸별로 정확히 분해한다', () => {
      // 2억 3,500만 원 (235,000,000)
      const boxes = bidBoxDigits(235_000_000);
      expect(boxes['억']).toBe(2);
      expect(boxes['천만']).toBe(3);
      expect(boxes['백만']).toBe(5);
      expect(boxes['십만']).toBe(0);
      expect(boxes['만']).toBe(0);
      expect(boxes['십억']).toBeNull(); // 앞쪽 빈자리는 null
      expect(boxes['백억']).toBeNull();
    });
  });

  describe('validateBidAmount (입찰가 안전 검증)', () => {
    it('최저매각가격 미만 입찰은 무효 오류를 반환한다', () => {
      const res = validateBidAmount(190_000_000, 200_000_000, 300_000_000);
      expect(res.isValid).toBe(false);
      expect(res.error).toContain('무효');
    });

    it('최저매각가격 이상이면 유효하며, 감정가 초과 시 주의 경고를 동봉한다', () => {
      const normal = validateBidAmount(220_000_000, 200_000_000, 300_000_000);
      expect(normal.isValid).toBe(true);
      expect(normal.warnings).toHaveLength(0);

      const high = validateBidAmount(350_000_000, 200_000_000, 300_000_000);
      expect(high.isValid).toBe(true);
      expect(high.warnings.some((w) => w.includes('감정가 초과'))).toBe(true);
    });
  });

  describe('requiredBidDocuments (입찰자 유형별 필수 서류)', () => {
    it('본인 직접 입찰 시 신분증, 도장, 보증금을 안내한다', () => {
      const docs = requiredBidDocuments('individual');
      expect(docs.some((d) => d.includes('신분증'))).toBe(true);
      expect(docs.some((d) => d.includes('도장'))).toBe(true);
      expect(docs.some((d) => d.includes('보증금'))).toBe(true);
    });

    it('대리인 입찰 시 인감증명서와 위임장을 필수로 포함한다', () => {
      const docs = requiredBidDocuments('proxy');
      expect(docs.some((d) => d.includes('인감증명서'))).toBe(true);
      expect(docs.some((d) => d.includes('위임장'))).toBe(true);
    });

    it('법인 입찰 시 법인등기부등본을 포함한다', () => {
      const docs = requiredBidDocuments('corporation');
      expect(docs.some((d) => d.includes('법인등기부등본'))).toBe(true);
    });

    it('농지(farmLand: true)인 경우 농취증 제출 경고를 포함한다', () => {
      const docs = requiredBidDocuments('individual', true);
      expect(docs.some((d) => d.includes('농지취득자격증명'))).toBe(true);
    });
  });
});
