/**
 * MOLIT 전월세 실거래 → 임대시세(전세보증금 / 월세 보증금·차임) 추정.
 * 임대수익률 엔진의 데이터층. (매매와 동일 MOLIT_SERVICE_KEY 재사용, 추가 키 불필요)
 */
import type { PropertyType } from '../../shared/types.ts';

const MOLIT_BASE = 'https://apis.data.go.kr/1613000';
const UA = 'gyeongmae-agent/0.1 (personal research)';
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
}

function recentYearMonths(months: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const num = (v: unknown) => parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

interface RentItem { deposit?: unknown; monthlyRent?: unknown; excluUseAr?: unknown; dealYear?: unknown; dealMonth?: unknown }
interface RentResp { response?: { body?: { items?: { item?: RentItem | RentItem[] } } } }

/** MOLIT 전월세 실거래 조회 (최근 months개월, 해당 법정동코드) */
export async function fetchRentDeals(propertyType: PropertyType, lawdCd: string, months: number): Promise<RentDeal[]> {
  const ep = RENT_ENDPOINT[propertyType];
  const key = process.env.MOLIT_SERVICE_KEY;
  if (!ep || !key) return [];
  const out: RentDeal[] = [];
  for (const ym of recentYearMonths(months)) {
    const url = `${MOLIT_BASE}/${ep}/get${ep}?serviceKey=${encodeURIComponent(key)}&LAWD_CD=${lawdCd}&DEAL_YMD=${ym}&numOfRows=400&pageNo=1&_type=json`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const json = (await res.json()) as RentResp;
      const raw = json?.response?.body?.items?.item;
      const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const it of items) {
        const deposit = num(it.deposit) * 10_000; // 만원→원
        const monthlyRent = num(it.monthlyRent) * 10_000;
        const areaM2 = parseFloat(String(it.excluUseAr ?? ''));
        if (!deposit || !areaM2) continue;
        out.push({ deposit, monthlyRent, areaM2, dealDate: `${it.dealYear}-${String(it.dealMonth ?? 1).padStart(2, '0')}` });
      }
    } catch { /* 개별 월 실패 무시 */ }
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
