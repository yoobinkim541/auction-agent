/**
 * 매물 표시용 순수 유틸 — App.tsx에서 추출(단위 테스트 대상).
 */
import type { ListingItem } from './api.ts';

/** 매각 차수 해석: sale_date 일치 차수 우선, 없으면 sale_rounds 최신/유찰수로 추정(est=true). */
export function resolveRound(
  rounds: { date: string; round: number }[], saleDate?: string | null, failCount?: number | null,
): { n: number; est: boolean } | null {
  if (!rounds.length) return null;
  const match = saleDate ? rounds.find((s) => s.date === saleDate) : null;
  if (match) return { n: match.round, est: false };
  const last = rounds[rounds.length - 1]!;
  if (saleDate && last.date < saleDate) {
    // sale_rounds가 구형(분석 후 sale_date 재갱신) → 최소 last.round+1 또는 유찰수+1로 추정
    const n = (failCount != null && failCount > 0) ? failCount + 1 : last.round + 1;
    return { n, est: true };
  }
  return { n: last.round, est: false };
}

/** 안전마진 → 지도 마커 색(진짜마진 우선, 없으면 raw 안전마진). */
export function marginColor(r: ListingItem): string {
  const tm = r.location?.acquisition_cost?.trueSafetyMargin ?? r.location?.safety_margin ?? null;
  if (tm == null) return '#7a8699';
  if (tm >= 0.3) return '#1ec758';
  if (tm >= 0.1) return '#a3d977';
  if (tm >= 0) return '#f5a623';
  return '#f04545';
}
