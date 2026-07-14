/**
 * 시세 추정용 순수 로직(네트워크 비의존) — 단위 테스트 대상.
 * index.ts(국토부 호출·지오코딩)에서 이 함수들을 가져다 쓴다.
 */
import type { Comparable } from '../../shared/types.ts';
import { median } from '../../shared/stats.ts';

/**
 * 국토부 dealAmount(만원, 콤마/공백 포함 문자열) → 원.
 * 음수·정정/취소 마커·비정상 magnitude 는 거부(null) — 오염된 한 건이 중위값을 흔드는 것 방지.
 */
export function parseMolitDealAmount(raw: unknown): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/[^0-9,\s]/.test(s)) return null; // 숫자·콤마·공백 외 문자(부호 '-', '정정' 등) → 신뢰 불가
  const n = parseInt(s.replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const won = n * 10_000; // 만원 → 원
  if (won < 10_000_000 || won > 100_000_000_000) return null; // 실거래 정상범위(1천만~1천억) 밖 거부
  return won;
}

/**
 * 법정동 경계 일치. 부분문자열 매칭("산동"이 "마산동"에 매칭)으로 타동네가 섞이던 문제 방지 →
 * trim 후 정확 일치만 인정. 양쪽 모두 국토부 umdNm/주소 추출 법정동 풀네임이므로 정확 비교가 안전.
 */
export function dongMatches(target: string | undefined, candidate: string | undefined): boolean {
  if (!target || !candidate) return false;
  return target.trim() === candidate.trim();
}

/** 주소에서 법정동(예: 천호동) 추출 */
export function extractDong(addr: string): string | undefined {
  const parts = addr.replace(/[,()]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (/[구군]$/.test(parts[i]!) && /[동읍면리가]$/.test(parts[i + 1]!)) return parts[i + 1];
  }
  return parts.find((p) => /[동읍면]$/.test(p) && p.length >= 2 && !/[구군시]$/.test(p));
}

/** 주소의 "(동,단지명)" 패턴에서 건물명 추출 */
export function extractBuildingName(addr: string): string | undefined {
  const m = addr.match(/\([^,)]*,\s*([^)]+)\)/);
  return m ? m[1]!.trim() : undefined;
}

export { median };

export interface Estimate {
  marketPrice: number | null;
  used: Comparable[];
  confidence: 'high' | 'medium' | 'low' | null;
  basis: string;
}

/**
 * 비교군을 동일건물 → 법정동+면적 → 법정동 → 구+면적 순으로 좁혀 시세 추정.
 * 빌라(연립다세대)는 단지가 이질적이라 '구 전체 중위값'은 부정확 → 법정동·면적 매칭을 우선.
 * 대상 면적이 없으면 면적 검증이 불가능하므로 '동일건물/법정동' 매칭이라도 high 로 올리지 않고
 * medium 으로 표기(면적 미검증 상태를 confidence 에 정직하게 반영).
 */
/**
 * 시세 sanity 상한(순수) — 저신뢰 실거래 추정이 감정가를 크게 넘으면 이질 평형·건물 매칭 오류일 공산이 큼.
 *   빌라·단독은 시세>감정이 드물어 감정가 상한, 아파트·오피스텔은 실제 상승 여지 있어 감정가×1.3까지 허용.
 *   동일건물·면적 매칭 high 신뢰는 예외(진짜 상승 반영). 백테스트: 시세 과대추정이 '고점수→유찰'의 최대 원인.
 */
export function capMarketPrice(
  marketPrice: number | null, confidence: Estimate['confidence'], appraisalValue: number | undefined, propertyType: string,
): { marketPrice: number | null; confidence: Estimate['confidence']; capped: boolean; overPct: number | null; thinType: boolean } {
  const thinType = propertyType === 'villa' || propertyType === 'house';
  if (!marketPrice || confidence === 'high' || !appraisalValue || appraisalValue <= 0) {
    return { marketPrice, confidence, capped: false, overPct: null, thinType };
  }
  const cap = Math.round(appraisalValue * (thinType ? 1.0 : 1.3));
  if (marketPrice > cap) {
    return { marketPrice: cap, confidence: 'low', capped: true, overPct: Math.round((marketPrice / appraisalValue) * 100), thinType };
  }
  return { marketPrice, confidence, capped: false, overPct: null, thinType };
}

export function estimateMarketPrice(
  comps: Comparable[],
  opts: { areaM2?: number; dong?: string; buildingName?: string },
): Estimate {
  const recent = [...comps].sort((a, b) => (a.dealDate < b.dealDate ? 1 : -1)); // 최근 우선
  const hasArea = opts.areaM2 != null && opts.areaM2 > 0;
  const areaOk = (c: Comparable) => !hasArea || Math.abs(c.areaM2 - opts.areaM2!) <= opts.areaM2! * 0.15;
  const dongOk = (c: Comparable) => dongMatches(opts.dong, c.dong);
  const nameOk = (c: Comparable) =>
    !!opts.buildingName && !!c.apartmentName && c.apartmentName.replace(/\s/g, '').includes(opts.buildingName.replace(/\s/g, ''));

  const areaConf: 'high' | 'medium' = hasArea ? 'high' : 'medium';
  const areaTag = hasArea ? '·면적' : '(면적미상)';

  const tiers: { basis: string; conf: 'high' | 'medium' | 'low'; sel: Comparable[]; need: number }[] = [];
  if (opts.buildingName) tiers.push({ basis: `'${opts.buildingName}' 동일건물${areaTag}`, conf: areaConf, need: 2, sel: recent.filter((c) => nameOk(c) && areaOk(c)) });
  if (opts.dong) tiers.push({ basis: `${opts.dong}${areaTag}`, conf: areaConf, need: 3, sel: recent.filter((c) => dongOk(c) && areaOk(c)) });
  if (opts.dong) tiers.push({ basis: `${opts.dong} 전체`, conf: 'medium', need: 3, sel: recent.filter((c) => dongOk(c)) });
  tiers.push({ basis: hasArea ? '구 전체·면적' : '구 전체(면적미상)', conf: 'low', need: 3, sel: recent.filter((c) => areaOk(c)) });

  for (const t of tiers) {
    if (t.sel.length >= t.need) {
      const used = t.sel.slice(0, 20);
      return { marketPrice: median(used.map((c) => c.dealAmount)), used, confidence: t.conf, basis: `${t.basis} ${used.length}건` };
    }
  }
  return { marketPrice: null, used: [], confidence: null, basis: '비교군 부족' };
}
