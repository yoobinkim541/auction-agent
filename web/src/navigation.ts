/**
 * 임장 이동용 지도/내비게이션 딥링크 생성 유틸.
 *
 * 카카오맵, 네이버지도, 티맵 딥링크를 생성하여 현장에서 스마트폰으로
 * 터치 시 길찾기/내비게이션으로 직결된다.
 */
export interface NavigationLinks {
  kakao: string;
  naver: string;
  tmap: string;
}

export function buildNavigationLinks(address: string, lat?: number | null, lng?: number | null): NavigationLinks {
  const cleanAddr = address.trim();
  const enc = encodeURIComponent(cleanAddr);

  const kakao =
    lat != null && lng != null
      ? `https://map.kakao.com/link/to/${enc},${lat},${lng}`
      : `https://map.kakao.com/link/search/${enc}`;

  const naver = `https://map.naver.com/p/search/${enc}`;

  const tmap =
    lat != null && lng != null
      ? `tmap://route?rGoName=${enc}&rGoX=${lng}&rGoY=${lat}`
      : `tmap://search?name=${enc}`;

  return { kakao, naver, tmap };
}
