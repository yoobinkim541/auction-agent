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

/** 국토부 매매 실거래 원자료 한 건(gm_molit_cache.items 의 원소). */
export interface MolitItem {
  dealAmount?: string; excluUseAr?: number | string;
  dealYear?: number | string; dealMonth?: number | string; dealDay?: number | string;
  floor?: number | string; buildYear?: number | string; umdNm?: string;
  aptNm?: string; mhouseNm?: string; offiNm?: string;
  jibun?: string; dealingGbn?: string; cdealType?: string;
}

/** 원자료 → 비교사례. 금액·면적이 없거나 해제된 계약은 버린다. */
export function parseMolitJson(item: MolitItem | MolitItem[] | undefined): Comparable[] {
  const items = Array.isArray(item) ? item : item ? [item] : [];
  const comps: Comparable[] = [];
  for (const it of items) {
    const dealAmount = parseMolitDealAmount(it.dealAmount); // 음수·정정표기·비정상값 거부
    const areaM2 = parseFloat(String(it.excluUseAr ?? ''));
    if (!dealAmount || !areaM2) continue;
    if (String(it.cdealType ?? '').trim()) continue; // 해제된 계약 — 체결가가 아니다
    const name = it.aptNm || it.mhouseNm || it.offiNm;
    comps.push({
      apartmentName: name != null ? String(name).trim() || undefined : undefined,
      dong: it.umdNm?.trim() || undefined,
      jibun: String(it.jibun ?? '').trim() || undefined,
      direct: String(it.dealingGbn ?? '').trim() === '직거래',
      areaM2,
      dealAmount,
      dealDate: `${it.dealYear}-${String(it.dealMonth ?? 1).padStart(2, '0')}-${String(it.dealDay ?? 1).padStart(2, '0')}`,
      floor: it.floor != null ? parseInt(String(it.floor), 10) : undefined,
      buildYear: it.buildYear != null ? parseInt(String(it.buildYear), 10) : undefined,
    });
  }
  return comps;
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

/** 지번 주소의 대표 지번(예: '서초동 1649-15 …' → '1649-15'). 도로명 주소에는 없다. */
export function extractLotNumber(addr: string): string | undefined {
  return addr.match(/(?:동|리|가)\s+(산?[0-9]+(?:-[0-9]+)?)(?:\s|$)/)?.[1];
}

export { median };

export interface Estimate {
  marketPrice: number | null;
  used: Comparable[];
  confidence: 'high' | 'medium' | 'low' | null;
  basis: string;
}

/**
 * 시세 sanity 상한(순수) — 저신뢰 실거래 추정이 감정가를 크게 넘으면 이질 평형·건물 매칭 오류일 공산이 큼.
 *   빌라·단독은 시세>감정이 드물어 감정가 상한, 아파트·오피스텔은 실제 상승 여지 있어 감정가×1.3까지 허용.
 *   동일건물·면적 매칭 high 신뢰는 예외(진짜 상승 반영). 백테스트: 시세 과대추정이 '고점수→유찰'의 최대 원인.
 *   오피스텔·상가·단독은 예외 없음 — 동·면적만 맞춘 비교군이 층·건물급에 따라 감정가의 3배 넘게 벌어진다(2026-11 실측).
 *   감정가의 3배 초과·0.3배 미만은 종류·신뢰도와 무관하게 비교군 오매칭으로 본다: 3배 초과는 상한,
 *   0.3배 미만은 값은 두고(후보를 늘리지 않는 쪽) low 로 내려 표시가 high 로 남지 않게 한다.
 */
const MISMATCH_OVER = 3;
const MISMATCH_UNDER = 0.3;
export function capMarketPrice(
  marketPrice: number | null, confidence: Estimate['confidence'], appraisalValue: number | undefined, propertyType: string,
): { marketPrice: number | null; confidence: Estimate['confidence']; capped: boolean; overPct: number | null; underPct: number | null; thinType: boolean } {
  const thinType = propertyType === 'villa' || propertyType === 'house';
  const mixedType = propertyType === 'officetel' || propertyType === 'commercial' || propertyType === 'house';
  const keep = { marketPrice, confidence, capped: false, overPct: null, underPct: null, thinType };
  if (!marketPrice || !appraisalValue || appraisalValue <= 0) return keep;
  const ratio = marketPrice / appraisalValue;
  if (ratio < MISMATCH_UNDER) return { ...keep, confidence: 'low', underPct: Math.round(ratio * 100) };
  if (confidence === 'high' && !mixedType && ratio <= MISMATCH_OVER) return keep;
  const cap = Math.round(appraisalValue * (thinType ? 1.0 : 1.3));
  if (marketPrice > cap) return { ...keep, marketPrice: cap, confidence: 'low', capped: true, overPct: Math.round(ratio * 100) };
  return keep;
}

const SAME_UNIT = 0.05;      // 같은 건물 안 같은 평형
const SIMILAR_AREA = 0.15;   // 비슷한 면적
const BUILD_YEAR_BAND = 5;   // 동 단위 비교군의 준공연도 허용폭(년)
const BUILDING_LATEST = 5;   // 같은 건물은 최근 5건만 — 시세 변동을 따라간다
const AREA_LATEST = 20;

/**
 * 비교군을 같은 건물(같은 면적 → 비슷한 면적 → 건물 전체) → 법정동+면적 → 법정동 → 구+면적 순으로 좁혀 시세 추정.
 *
 * 같은 건물은 지번으로 고른다. 법원 주소에는 '(동,단지명)' 꼴이 드물어 이름만으로는 활성 매물의 1%도 건물을
 * 못 찾았고, 빌라는 같은 동에 같은 이름이 흔하다. 실거래에 지번이 없으면 이름 앞부분이 맞는지 본다.
 * 법원 대표지번은 '146-18외 1필지' 꼴이면 앞의 지번만 쓰고, 블록 이름처럼 지번이 아니면 없는 것으로 본다.
 * 오피스텔은 그 지번에 거래가 한 건도 없으면 이름이 똑같은 거래를 같은 건물로 쓴다(신뢰도 medium 까지) — 한 건물이
 * 여러 필지에 걸쳐 대표지번과 실거래 지번이 다른 경우다. 지번 거래를 빼고 맞혀 본 결과(2026-07~10, 141건)
 * 20% 넘게 빗나간 비율이 동 단위 19.9% → 9.2%. 이름 앞부분만 맞는 거래는 차이가 없었고(22.7% → 22.3%),
 * 빌라는 이름이 같아도 오히려 나빠져(38.6% → 46.6%) 넣지 않았다.
 * 값은 ㎡당가 중앙값 × 대상 면적 — 면적이 ±15% 안에서 달라도 총액이 그만큼 밀리지 않는다.
 * 직거래는 중개거래만으로 그 단계의 최소 건수를 못 채울 때만 섞는다(가족 간 거래 등 시세와 먼 값이 섞인다).
 *
 * 신뢰도는 단계별 실측 오차를 따른다. 실거래 한 건씩을 그 전 1년 거래로 맞혀 본 결과(2026-07~10 체결분,
 * 중앙 오차 / 20% 넘게 빗나간 비율, 아파트·빌라·오피스텔 순):
 *   high   같은 건물·같은(비슷한) 면적 2건 이상   3.8% / 1%,  6.1% / 14%,  4.2% / 4%
 *   medium 같은 건물·같은 면적 1건                 5.4% / 9%,  8.9% / 23%,  5.5% / 9%
 *          같은 건물 전체(㎡당가 환산)             14.3% / 31%, 14.4% / 38%, 12.8% / 32%
 *          동·면적·준공±5년 3건 이상(빌라·오피스텔) 14.4% / 37%, 15.5% / 39%
 *   low    동·면적(준공 무관), 동 전체, 구 전체     30% 안팎 / 60~80% (준공연도를 몰라 못 거른 경우도 빌라 19.8% / 50%)
 * 아파트와 상가는 동 단위 비교군을 low 로 둔다 — 아파트는 단지마다 값이 달라 준공연도를 맞춰도 32.9% / 64%,
 * 상가는 층·건물에 따라 갈려 17.8% / 47%(P90 83%)였다.
 * 백테스트(경매 매물 3,448건, 정답 = 평가일 뒤 180일 안 같은 건물·같은 면적 실거래): 중앙 오차 13.8% → 5.8%.
 */
export function estimateMarketPrice(
  comps: Comparable[],
  opts: { areaM2?: number; dong?: string; buildingName?: string; jibun?: string; buildYear?: number; propertyType?: string },
): Estimate {
  const recent = [...comps].sort((a, b) => (a.dealDate < b.dealDate ? 1 : a.dealDate > b.dealDate ? -1 : 0)); // 최근 우선
  const area = opts.areaM2 != null && opts.areaM2 > 0 ? opts.areaM2 : null;
  const within = (c: Comparable, tolerance: number) => area === null || Math.abs(c.areaM2 - area) <= area * tolerance;
  const inDong = recent.filter((c) => dongMatches(opts.dong, c.dong));
  const name = opts.buildingName?.replace(/\s/g, '') ?? '';
  const lot = opts.jibun?.match(/^산?\d+(?:-\d+)?/)?.[0];
  const byLot = inDong.filter((c) => {
    if (lot && c.jibun) return c.jibun === lot;
    const other = c.apartmentName?.replace(/\s/g, '') ?? '';
    return Math.min(name.length, other.length) >= 3 && (name.startsWith(other) || other.startsWith(name));
  });
  const byName = byLot.length === 0 && opts.propertyType === 'officetel' && name.length >= 3;
  const building = byName ? inDong.filter((c) => c.apartmentName?.replace(/\s/g, '') === name) : byLot;
  const buildingLabel = byName
    ? `'${opts.buildingName}' 동일건물(이름 일치)`
    : opts.buildingName ? `'${opts.buildingName}' 동일건물` : `${opts.dong} ${lot ?? opts.jibun} 동일건물`;
  const matched = (sel: Comparable[]): 'high' | 'medium' => (sel.length >= 2 && !byName ? 'high' : 'medium');
  const dongConf = opts.propertyType === 'apartment' || opts.propertyType === 'commercial' ? 'low' : 'medium';

  const tiers: { basis: string; conf: 'high' | 'medium' | 'low'; sel: Comparable[]; need: number; latest: number }[] = [];
  if (area === null) {
    tiers.push({ basis: `${buildingLabel}(면적미상)`, conf: 'medium', need: 1, latest: BUILDING_LATEST, sel: building });
    tiers.push({ basis: `${opts.dong}(면적미상)`, conf: 'low', need: 3, latest: AREA_LATEST, sel: inDong });
    tiers.push({ basis: '구 전체(면적미상)', conf: 'low', need: 3, latest: AREA_LATEST, sel: recent });
  } else {
    const sameUnit = building.filter((c) => within(c, SAME_UNIT));
    const similarUnit = building.filter((c) => within(c, SIMILAR_AREA));
    tiers.push({ basis: `${buildingLabel}·동일면적`, conf: matched(sameUnit), need: 1, latest: BUILDING_LATEST, sel: sameUnit });
    tiers.push({ basis: `${buildingLabel}·유사면적`, conf: matched(similarUnit), need: 1, latest: BUILDING_LATEST, sel: similarUnit });
    tiers.push({ basis: `${buildingLabel} 전체(㎡당가 환산)`, conf: 'medium', need: 1, latest: BUILDING_LATEST, sel: building });
    const dongArea = inDong.filter((c) => within(c, SIMILAR_AREA));
    const sameEra = opts.buildYear == null
      ? []
      : dongArea.filter((c) => c.buildYear == null || Math.abs(c.buildYear - opts.buildYear!) <= BUILD_YEAR_BAND);
    if (sameEra.length >= 3) tiers.push({ basis: `${opts.dong}·면적·준공±${BUILD_YEAR_BAND}년`, conf: dongConf, need: 3, latest: AREA_LATEST, sel: sameEra });
    tiers.push({ basis: `${opts.dong}·면적`, conf: 'low', need: 3, latest: AREA_LATEST, sel: dongArea });
    tiers.push({ basis: `${opts.dong} 전체(㎡당가 환산)`, conf: 'low', need: 3, latest: AREA_LATEST, sel: inDong });
    tiers.push({ basis: '구 전체·면적', conf: 'low', need: 3, latest: AREA_LATEST, sel: recent.filter((c) => within(c, SIMILAR_AREA)) });
  }

  for (const t of tiers) {
    if (t.sel.length < t.need) continue;
    const brokered = t.sel.filter((c) => !c.direct);
    const used = (brokered.length >= t.need ? brokered : t.sel).slice(0, t.latest);
    const mid = median(used.map((c) => (area === null ? c.dealAmount : c.dealAmount / c.areaM2)))!; // used 는 비어 있지 않다
    const marketPrice = area === null ? mid : Math.round((mid * area) / 10_000) * 10_000; // 실거래 단위(만원)로 맞춘다
    return { marketPrice, used, confidence: t.conf, basis: `${t.basis} ${used.length}건` };
  }
  return { marketPrice: null, used: [], confidence: null, basis: '비교군 부족' };
}
