/**
 * 통계/날짜 헬퍼 — 빈 입력은 null 계약(호출부에서 명시 가드). 짝수 개수는 두 중앙값 평균을 반올림.
 * (이전엔 acquisition=NaN / rent·comps=null 로 계약이 갈려 통합 시 숨은 버그 위험. ADR 리뷰 #4)
 */

/** 중앙값. 빈 배열 → null. 짝수 개수 → 가운데 두 값 평균(반올림). */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/**
 * 현재(UTC)부터 최근 N개월의 YYYYMM 문자열 배열을 반환한다. (가장 최근 달 먼저)
 * UTC 기준 사용 이유: MOLIT 캐시 키의 일관성 보장(서버 로컬 타임존 독립).
 */
export function recentYearMonths(months: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
