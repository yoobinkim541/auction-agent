import { describe, expect, it } from 'vitest';
import { addressToLawdCd } from './lawd-codes.ts';

describe('addressToLawdCd', () => {
  describe('서울 시군구', () => {
    it('강남구', () => {
      expect(addressToLawdCd('서울특별시 강남구 역삼동 1-2')).toBe('11680');
    });

    it('마포구', () => {
      expect(addressToLawdCd('서울시 마포구 공덕동 100')).toBe('11440');
    });

    it('종로구', () => {
      expect(addressToLawdCd('서울 종로구 혜화동 1')).toBe('11110');
    });

    it('서울 중구 (인천 중구와 구별)', () => {
      expect(addressToLawdCd('서울특별시 중구 을지로 1')).toBe('11140');
    });
  });

  describe('인천 시군구', () => {
    it('인천 중구 (서울 중구와 구별)', () => {
      expect(addressToLawdCd('인천광역시 중구 신포동 1')).toBe('28110');
    });

    it('부평구', () => {
      expect(addressToLawdCd('인천 부평구 부평동 200')).toBe('28237');
    });

    it('연수구 (송도)', () => {
      expect(addressToLawdCd('인천 연수구 송도동 15')).toBe('28185');
    });
  });

  describe('경기 시군구', () => {
    it('구가 있는 시: 수원 영통구', () => {
      expect(addressToLawdCd('경기도 수원시 영통구 이의동')).toBe('41117');
    });

    it('구가 있는 시: 성남 분당구', () => {
      expect(addressToLawdCd('경기 성남시 분당구 정자동 12')).toBe('41135');
    });

    it('구가 있는 시: 고양 일산동구 vs 일산서구', () => {
      expect(addressToLawdCd('고양시 일산동구 백석동')).toBe('41285');
      expect(addressToLawdCd('고양시 일산서구 주엽동')).toBe('41287');
    });

    it('구가 없는 시: 경기도 광주시 (광주광역시와 구별)', () => {
      expect(addressToLawdCd('경기도 광주시 태전동 10')).toBe('41610');
    });

    it('구가 없는 시: 하남시', () => {
      expect(addressToLawdCd('경기 하남시 망월동')).toBe('41450');
    });

    it('구가 없는 시: 부천시', () => {
      expect(addressToLawdCd('경기 부천시 원미동')).toBe('41190');
    });
  });

  describe('수도권 외 / 미매칭', () => {
    it('지방 도시는 undefined 반환', () => {
      expect(addressToLawdCd('부산광역시 해운대구 우동')).toBeUndefined();
      expect(addressToLawdCd('대전광역시 유성구 봉명동')).toBeUndefined();
    });

    it('빈 주소는 undefined 반환', () => {
      expect(addressToLawdCd('')).toBeUndefined();
    });
  });
});
