/**
 * 취득세 클라이언트 미러 — pipeline/cost/acquisition.ts 의 acquisitionTaxRate 와 동일 로직.
 * 상세 드로어의 '희망 낙찰가 입력 → 실시간 취득비용' 계산기에서 사용.
 * (명도비·국민주택채권 본인부담은 낙찰가와 무관하게 일정 → 서버 계산값을 상수로 재사용)
 */
const EOK = 100_000_000;
const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
const KO_85SQM = 85;

export interface AcqTaxResult { totalRatePct: number; totalKRW: number; note: string }

export function acquisitionTaxRate(
  propertyType: string, priceKRW: number, areaM2: number,
  opts: { homeCountAfter?: number; isRegulatedArea?: boolean; officetelAsHouse?: boolean } = {},
): AcqTaxResult {
  const over85 = (areaM2 || 0) > KO_85SQM;
  const fin = (acq: number, rural: number, edu: number, note: string): AcqTaxResult => {
    const total = round5(acq + rural + edu);
    return { totalRatePct: total, totalKRW: Math.round(priceKRW * total / 100), note };
  };
  const asHouse = propertyType === 'apartment' || propertyType === 'villa' || propertyType === 'house'
    || (propertyType === 'officetel' && opts.officetelAsHouse);

  if (!asHouse) {
    return fin(4.0, 0.2, 0.4, propertyType === 'officetel' ? '오피스텔 4.6%(공부상 업무시설)' : '비주거 4.6%');
  }
  const homes = opts.homeCountAfter ?? 1;
  const regulated = opts.isRegulatedArea ?? false;
  const twelve = (regulated && homes >= 3) || (!regulated && homes >= 4);
  if (twelve) return fin(12.0, over85 ? 1.0 : 0.0, 0.4, `12% 중과(${regulated ? '조정3주택+' : '비조정4주택+'})`);
  const eight = (regulated && homes === 2) || (!regulated && homes === 3);
  if (eight) return fin(8.0, over85 ? 0.6 : 0.0, 0.4, `8% 중과(${regulated ? '조정2주택' : '비조정3주택'})`);
  let acq: number;
  const eok = priceKRW / EOK;
  if (priceKRW <= 6 * EOK) acq = 1.0; else if (priceKRW <= 9 * EOK) acq = round5(eok * 2 / 3 - 3); else acq = 3.0;
  acq = Math.min(3.0, Math.max(1.0, acq));
  return fin(acq, over85 ? 0.2 : 0.0, round5(acq * 0.1), `기본세율 ${acq}%(${homes === 1 ? '1주택' : '비조정2주택'})`);
}
