/**
 * MOLIT 전월세 실거래 → 임대시세(전세보증금 / 월세 보증금·차임) 추정.
 * 임대수익률 엔진의 데이터층. (매매와 동일 MOLIT_SERVICE_KEY 재사용, 추가 키 불필요)
 */
import type { PropertyType } from '../../shared/types.ts';
import { fetchMolitRaw } from '../../shared/molit-cache.ts';
import { median, recentYearMonths } from '../../shared/stats.ts';

const RENT_ENDPOINT: Partial<Record<PropertyType, string>> = {
  apartment: 'RTMSDataSvcAptRent', // 아파트 전월세
  villa: 'RTMSDataSvcRHRent', // 연립다세대 전월세
  officetel: 'RTMSDataSvcOffiRent', // 오피스텔 전월세
};

export interface RentDeal {
  deposit: number; // 보증금(원)
  monthlyRent: number; // 월세(원), 0이면 전세
  areaM2: number;
  dealDate: string; // YYYY-MM
}

export interface RentEstimate {
  jeonseDeposit: number | null; // 전세 보증금 시세(원) — 월세 0 거래 중앙값
  monthlyDeposit: number | null; // 월세 거래의 보증금 중앙값(원)
  monthlyRent: number | null; // 월세 차임 중앙값(원/월)
  n: number; // 사용 거래 수
  nJeonse: number;
  nMonthly: number;
  basis: string;
  estimated?: boolean; // 실거래 아님 — 전세가율 가정으로 역산한 추정치
}

// 수도권 전세가율 가정(실거래 미확보 시 fallback). 보수적 중앙값 — 실제는 단지·연식별 편차 큼.
// 아파트 < 빌라 < 오피스텔 순으로 전세가율이 높은 시장 경향 반영.
const JEONSE_RATIO: Partial<Record<PropertyType, number>> = {
  apartment: 0.60,
  villa: 0.68,
  officetel: 0.75,
};

/**
 * 전월세 실거래가 없을 때(쿼터/표본부족) 매매시세 × 지역·유형 전세가율로 전세보증금만 추정.
 * 월세는 추정하지 않음(보증금↔차임 전환율 가정이 과도) → 갭/전세가율 화면용 저신뢰 추정치.
 */
export function estimateRentFromSalePrice(propertyType: PropertyType, marketPrice: number | null): RentEstimate {
  const empty: RentEstimate = { jeonseDeposit: null, monthlyDeposit: null, monthlyRent: null, n: 0, nJeonse: 0, nMonthly: 0, basis: '' };
  if (!marketPrice || marketPrice <= 0) return empty;
  const ratio = JEONSE_RATIO[propertyType] ?? 0.65;
  return {
    jeonseDeposit: Math.round(marketPrice * ratio),
    monthlyDeposit: null, monthlyRent: null,
    n: 0, nJeonse: 0, nMonthly: 0,
    estimated: true,
    basis: `전세 실거래 미확보 — 전세가율 ${Math.round(ratio * 100)}% 가정 추정(저신뢰, 실제 확인 필요)`,
  };
}

const num = (v: unknown) => parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0;

interface RentItem { deposit?: unknown; monthlyRent?: unknown; excluUseAr?: unknown; dealYear?: unknown; dealMonth?: unknown }

/** MOLIT 전월세 실거래 조회 (최근 months개월, 해당 법정동코드) — DB 영구 캐시 경유(shared/molit-cache) */
export async function fetchRentDeals(propertyType: PropertyType, lawdCd: string, months: number): Promise<RentDeal[]> {
  const ep = RENT_ENDPOINT[propertyType];
  if (!ep) return [];
  const out: RentDeal[] = [];
  for (const ym of recentYearMonths(months)) {
    const items = await fetchMolitRaw(ep, lawdCd, ym);
    if (items === null) continue; // 캐시 없는 월 건너뜀 — 쿼터 시에도 다른 월 캐시는 활용
    for (const it of items as RentItem[]) {
      const deposit = num(it.deposit) * 10_000; // 만원→원
      const monthlyRent = num(it.monthlyRent) * 10_000;
      const areaM2 = parseFloat(String(it.excluUseAr ?? ''));
      if (!deposit || !areaM2) continue;
      out.push({ deposit, monthlyRent, areaM2, dealDate: `${it.dealYear}-${String(it.dealMonth ?? 1).padStart(2, '0')}` });
    }
  }
  return out;
}

/** 전월세 거래에서 동일면적(±15%) 중앙값으로 전세/월세 시세 추정 */
export function estimateRent(deals: RentDeal[], subjectAreaM2: number | undefined): RentEstimate {
  const empty: RentEstimate = { jeonseDeposit: null, monthlyDeposit: null, monthlyRent: null, n: 0, nJeonse: 0, nMonthly: 0, basis: '' };
  if (!deals.length) return empty;
  const near = subjectAreaM2
    ? deals.filter((d) => Math.abs(d.areaM2 - subjectAreaM2) / subjectAreaM2 <= 0.15)
    : deals;
  const use = near.length >= 3 ? near : deals;
  const jeonse = use.filter((d) => d.monthlyRent === 0);
  const monthly = use.filter((d) => d.monthlyRent > 0);
  return {
    jeonseDeposit: median(jeonse.map((d) => d.deposit)),
    monthlyDeposit: median(monthly.map((d) => d.deposit)),
    monthlyRent: median(monthly.map((d) => d.monthlyRent)),
    n: use.length, nJeonse: jeonse.length, nMonthly: monthly.length,
    basis: `MOLIT 전월세 ${use.length}건${near.length >= 3 && subjectAreaM2 ? `(전용 ${subjectAreaM2}㎡±15%)` : ''}`,
  };
}
