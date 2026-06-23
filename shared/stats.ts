/**
 * 통계 헬퍼 — 빈 입력은 null 계약(호출부에서 명시 가드). 짝수 개수는 두 중앙값 평균을 반올림.
 * (이전엔 acquisition=NaN / rent·comps=null 로 계약이 갈려 통합 시 숨은 버그 위험. ADR 리뷰 #4)
 */

/** 중앙값. 빈 배열 → null. 짝수 개수 → 가운데 두 값 평균(반올림). */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}
