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
      expect(addressToLawdCd('인천광역시 중구 신포동 1')).toBe('28125');
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

    it('인천 2026-07 개편: 새 구 이름은 새 코드', () => {
      expect(addressToLawdCd('인천광역시 제물포구 송림동 10')).toBe('28125');
      expect(addressToLawdCd('인천광역시 영종구 운북동 7')).toBe('28155');
      expect(addressToLawdCd('인천광역시 검단구 당하동 1085-11 에코타운 3층304호')).toBe('28290');
      expect(addressToLawdCd('인천광역시 동구 송현동 1')).toBe('28125');
      expect(addressToLawdCd('인천광역시 남동구 구월동 1')).toBe('28200');
    });

    it('인천 옛 중구·서구는 동으로 새 구를 고른다', () => {
      expect(addressToLawdCd('인천광역시 중구 운서동 2799-1 두림타워 1층101호')).toBe('28155');
      expect(addressToLawdCd('인천광역시 중구 하늘중앙로225번길 20 9층904호 (중산동,스카이에비뉴)')).toBe('28155');
      expect(addressToLawdCd('인천광역시 중구 항동7가 49-33')).toBe('28125');
      expect(addressToLawdCd('인천광역시 서구 청라동 100')).toBe('28275');
      expect(addressToLawdCd('인천광역시 서구 검단로 419 105동 4층411호 (왕길동,원흥아파트)')).toBe('28290');
    });

    it('인천 옛 중구·서구인데 동이 없으면 코드를 내지 않는다', () => {
      expect(addressToLawdCd('인천광역시 서구 가석로 190-8')).toBeUndefined();
      expect(addressToLawdCd('인천광역시 중구 축항대로86번길 47, 3동 1')).toBeUndefined();
    });

    it('부천: 구가 적힌 주소는 구 코드', () => {
      expect(addressToLawdCd('경기도 부천시 원미구 심곡동 100')).toBe('41192');
      expect(addressToLawdCd('경기도 부천시 소사구 심곡본동 5')).toBe('41194');
      expect(addressToLawdCd('경기도 부천시 오정구 원종동 7')).toBe('41196');
    });

    it('부천: 구가 빠진 주소는 동으로 구를 찾는다', () => {
      expect(addressToLawdCd('경기 부천시 원미동')).toBe('41192');
      expect(addressToLawdCd('경기도 부천시 경인로159번길 9 6층601호 (송내동,지오빌)')).toBe('41194');
      expect(addressToLawdCd('경기도 부천시 정주로 94 2층203호 (도당동,비즈타워)')).toBe('41192');
    });

    it('화성: 구 또는 읍·면·동으로 구 코드', () => {
      expect(addressToLawdCd('경기도 화성시 동탄구 동탄대로시범길 276')).toBe('41597');
      expect(addressToLawdCd('경기도 화성시 향남읍 행정리 100')).toBe('41591');
      expect(addressToLawdCd('경기도 화성시 봉담읍 상리 12')).toBe('41593');
      expect(addressToLawdCd('경기도 화성시 병점동 300')).toBe('41595');
      expect(addressToLawdCd('경기도 화성시 송산면 육일리 281-21')).toBe('41591');
      expect(addressToLawdCd('경기도 화성시 송산동 20')).toBe('41595');
    });

    it('화성 능동은 두 구에 걸쳐 있어 구가 없으면 코드를 내지 않는다', () => {
      expect(addressToLawdCd('경기도 화성시 능동 1066')).toBeUndefined();
      expect(addressToLawdCd('경기도 화성시 동탄구 능동 1066')).toBe('41597');
    });

    it('동을 못 찾은 부천·화성 주소는 실거래 없는 옛 코드 대신 undefined', () => {
      expect(addressToLawdCd('경기도 화성시 병점4로 102')).toBeUndefined();
    });
  });

  describe('수도권 외 / 미매칭', () => {
    it('시·도는 주소 머리에서만 읽는다(건물명 속 서울 무시)', () => {
      expect(addressToLawdCd('경기도 김포시 김포한강11로 255, 호텔마리나베이서울 5층')).toBe('41570');
      expect(addressToLawdCd('인천광역시 남동구 만수동 1, 만수뉴서울아파트 2동')).toBe('28200');
    });

    it('옛 이름·새 이름: 인천 서해구·남구, 평택군', () => {
      expect(addressToLawdCd('인천광역시 서해구 연희동 740-2')).toBe('28275');
      expect(addressToLawdCd('인천광역시 남구 주안동 10')).toBe('28177');
      expect(addressToLawdCd('경기도 평택군 팽성읍 안정리 1')).toBe('41220');
    });

    it('지방 도시는 undefined 반환', () => {
      expect(addressToLawdCd('부산광역시 해운대구 우동')).toBeUndefined();
      expect(addressToLawdCd('대전광역시 유성구 봉명동')).toBeUndefined();
    });

    it('빈 주소는 undefined 반환', () => {
      expect(addressToLawdCd('')).toBeUndefined();
    });
  });
});
