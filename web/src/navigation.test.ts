import { describe, expect, it } from 'vitest';
import { buildNavigationLinks } from './navigation.ts';

describe('web/src/navigation', () => {
  it('주소만 있을 때 각 지도 서비스별 검색 URL을 생성한다', () => {
    const address = '서울특별시 강남구 역삼동 1-2';
    const links = buildNavigationLinks(address);

    expect(links.kakao).toContain('map.kakao.com/link/search');
    expect(links.kakao).toContain(encodeURIComponent(address));
    expect(links.naver).toContain('map.naver.com/p/search');
    expect(links.naver).toContain(encodeURIComponent(address));
    expect(links.tmap).toContain('tmap://search');
    expect(links.tmap).toContain(encodeURIComponent(address));
  });

  it('위경도 좌표가 있으면 카카오맵과 티맵의 목적지 길안내 딥링크를 생성한다', () => {
    const address = '인천광역시 중구 신포동 1';
    const lat = 37.472;
    const lng = 126.621;
    const links = buildNavigationLinks(address, lat, lng);

    expect(links.kakao).toContain('map.kakao.com/link/to');
    expect(links.kakao).toContain('37.472,126.621');
    expect(links.tmap).toContain('tmap://route');
    expect(links.tmap).toContain('rGoY=37.472');
    expect(links.tmap).toContain('rGoX=126.621');
  });
});
