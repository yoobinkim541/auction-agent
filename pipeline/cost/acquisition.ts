/**
 * 낙찰 취득비용 모델 — '진짜 안전마진'을 위한 부대비용 계산.
 *
 * 더낙찰옥션 상세페이지의 "낙찰시 추가비용(참고용)"을 코드로 정밀화한다:
 *   총취득비용 = 낙찰가 + 취득세(취득세+농특세+지방교육세) + 명도비 + 국민주택채권 본인부담
 *               + 권리 인수금액 + 기타
 *   진짜 안전마진 = (시세 − 총취득비용) / 시세
 *
 * 도메인 근거(2026.6): 취득세 과세표준 = 낙찰가(매각가), 국민주택채권 매입 = 시가표준액(공시가격).
 * 본 계산은 참고용 추정이며 세무·법률 자문이 아니다. 실제 세액/채권할인율은 위택스·주택도시기금 재확인.
 */
import type {
  PropertyType, SiteComparable, LandUseFlag, AcquisitionCost,
} from '../../shared/types.ts';
import { won, EOK } from '../../shared/format.ts';
import { m2ToPyeong } from '../../shared/units.ts';
import { median } from '../../shared/stats.ts';

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
const KO_85SQM = 85; // 국민주택규모(수도권·도시지역 전용면적 기준)

// ───────────────────────── 취득세 ─────────────────────────

export interface AcqTaxOptions {
  homeCountAfter?: number; // 취득 후 보유 총 주택수(이 물건 포함). 기본 1(개인 1주택).
  isRegulatedArea?: boolean; // 조정대상지역(중과 판정용; 1주택이면 무관)
  isCorporation?: boolean;
  isFarmland?: boolean;
  /** 주거용 오피스텔을 주택세율로 계산(소수의견). 기본 false=취득세는 공부상 용도(업무시설) 4.6% */
  officetelAsHouse?: boolean;
}
export interface AcqTaxResult {
  totalRatePct: number; acquisitionPct: number; ruralPct: number; eduPct: number;
  totalKRW: number; note: string;
}

/** 취득세+농어촌특별세+지방교육세 합산. priceKRW=낙찰가(과세표준). */
export function acquisitionTaxRate(
  propertyType: PropertyType, priceKRW: number, areaM2: number, options: AcqTaxOptions = {},
): AcqTaxResult {
  const over85 = (areaM2 || 0) > KO_85SQM;
  const finalize = (acq: number, rural: number, edu: number, note: string): AcqTaxResult => {
    const total = round5(acq + rural + edu);
    return { totalRatePct: total, acquisitionPct: acq, ruralPct: rural, eduPct: edu, totalKRW: Math.round(priceKRW * total / 100), note };
  };

  const asHouse = propertyType === 'apartment' || propertyType === 'villa' || propertyType === 'house'
    || (propertyType === 'officetel' && options.officetelAsHouse);

  // 비주택: 오피스텔(기본)/상가/토지/기타 → 4.6% 단일 (농지만 3.4%)
  if (!asHouse) {
    if (propertyType === 'land' && options.isFarmland) return finalize(3.0, 0.2, 0.2, '농지 유상취득 3.4%(자경감면 미반영).');
    return finalize(4.0, 0.2, 0.4,
      propertyType === 'officetel'
        ? '오피스텔 취득세는 공부상 업무시설 기준 4.6% 단일(주거 사용해도 취득세는 4.6%; 주택수 산입은 별개). 주택세율 적용을 원하면 officetelAsHouse 옵션.'
        : '비주거(상가/토지/기타) 4.6%.');
  }

  // 주택(아파트/빌라/단독, 또는 officetelAsHouse 오피스텔)
  if (options.isCorporation) return finalize(12.0, over85 ? 1.0 : 0.0, 0.4, '법인 주택취득 12% 중과(지역·주택수 무관).');
  const homes = options.homeCountAfter ?? 1;
  const regulated = options.isRegulatedArea ?? false;

  const twelve = (regulated && homes >= 3) || (!regulated && homes >= 4);
  if (twelve) return finalize(12.0, over85 ? 1.0 : 0.0, 0.4, `12% 중과(${regulated ? '조정 3주택+' : '비조정 4주택+'}).`);
  const eight = (regulated && homes === 2) || (!regulated && homes === 3);
  if (eight) return finalize(8.0, over85 ? 0.6 : 0.0, 0.4, `8% 중과(${regulated ? '조정 2주택' : '비조정 3주택'}). 일시적2주택이면 기본세율.`);

  // 기본세율(1주택 또는 비조정 2주택): 가액 누진 1~3%
  let acq: number;
  const eok = priceKRW / EOK;
  if (priceKRW <= 6 * EOK) acq = 1.0;
  else if (priceKRW <= 9 * EOK) acq = round5(eok * 2 / 3 - 3);
  else acq = 3.0;
  acq = Math.min(3.0, Math.max(1.0, acq));
  const edu = round5(acq * 0.1);
  const rural = over85 ? 0.2 : 0.0;
  return finalize(acq, rural, edu, `기본세율(${homes === 1 ? '1주택' : '비조정 2주택'}) ${acq}%+교육세${edu}%+농특세${rural}%.`);
}

// ───────────────────── 국민주택채권 ─────────────────────

export type BondRegion = '서울/광역시' | '기타';
export interface BondCost { faceAmount: number; ownCost: number }

const BOND_SEOUL: [number, number, number][] = [
  [20_000_000, 50_000_000, 13], [50_000_000, 100_000_000, 19], [100_000_000, 160_000_000, 21],
  [160_000_000, 260_000_000, 23], [260_000_000, 600_000_000, 26], [600_000_000, Infinity, 31],
];
const BOND_OTHER: [number, number, number][] = [
  [20_000_000, 50_000_000, 13], [50_000_000, 100_000_000, 14], [100_000_000, 160_000_000, 16],
  [160_000_000, 260_000_000, 18], [260_000_000, 600_000_000, 21], [600_000_000, Infinity, 26],
];

/** 제1종 국민주택채권 매입액 + 즉시매도 본인부담 추정. base=시가표준액(공시가격). discountRate 기본 0.14(보수적). */
export function estimateHousingBondCost(gongPrice: number, region: BondRegion, discountRate = 0.14): BondCost {
  if (!gongPrice || gongPrice < 20_000_000) return { faceAmount: 0, ownCost: 0 };
  const table = region === '서울/광역시' ? BOND_SEOUL : BOND_OTHER;
  const row = table.find(([lo, hi]) => gongPrice >= lo && gongPrice < hi);
  const perThousand = row ? row[2] : 0;
  const faceAmount = Math.round((gongPrice * perThousand / 1000) / 10_000) * 10_000; // 1만원 단위
  return { faceAmount, ownCost: Math.round(faceAmount * discountRate) };
}

/** 주소 → 채권 매입률 지역구분(서울·광역시 동일률, 경기 등은 기타) */
export function bondRegionFromAddress(address: string): BondRegion {
  return /서울|인천|부산|대구|광주|대전|울산/.test(address) ? '서울/광역시' : '기타';
}

// ───────────────────────── 명도비 ─────────────────────────

/** 면적 기반 예상 명도비(사이트 표기값 없을 때의 폴백). 접수 10만 + 운반/보관 110만 + 노무자수×12만. */
export function estimateMoveOutCost(areaPyeong: number): number {
  const py = areaPyeong || 0;
  let labor: number;
  if (py < 5) labor = 3; else if (py < 10) labor = 6; else if (py < 20) labor = 9;
  else if (py < 30) labor = 12; else if (py < 40) labor = 15; else if (py < 50) labor = 18;
  else labor = 18 + Math.ceil((py - 50) / 10) * 2;
  return 100_000 + 1_100_000 + labor * 120_000;
}

// ─────────────── 시세(동일건물 실거래) / 예상낙찰가 ───────────────

// median은 shared/stats.ts에서 import(빈입력 null 계약)

/** 사이트 동일건물 실거래에서 전용면적이 비슷한(±15%) 거래의 중앙값 → 시세(원). */
export function marketFromSiteComps(comps: SiteComparable[] | undefined, subjectAreaM2: number | undefined): { price: number | null; n: number; basis: string } {
  if (!comps?.length || !subjectAreaM2) return { price: null, n: 0, basis: '' };
  const near = comps.filter((c) => c.areaM2 > 0 && Math.abs(c.areaM2 - subjectAreaM2) / subjectAreaM2 <= 0.15);
  const use = near.length >= 2 ? near : comps;
  const prices = use.map((c) => c.dealManwon * 10_000).filter((p) => p > 0);
  if (!prices.length) return { price: null, n: 0, basis: '' };
  const p = median(prices)!;
  return { price: Math.round(p), n: prices.length, basis: `동일건물 실거래 ${prices.length}건(${near.length >= 2 ? `전용 ${subjectAreaM2}㎡±15%` : '전체평형'}) 중앙값` };
}

/**
 * 예상낙찰가 = 감정가 × 낙찰가율(동일건물 우선, 없으면 인근 중앙값).
 * 단, 유찰이 많아 최저가가 크게 낮아진 물건(최저가 > 감정가×비율×1.5 → 과대 추정)은
 * 최저가 × 1.3 으로 대체(현실적 경쟁 오버비드 추정).
 */
export function expectedBid(appraisalValue: number, sameBuilding?: number[], nearby?: number[], minBidPrice?: number): { price: number | null; ratioPct: number | null; basis: string } {
  const ratios = (sameBuilding && sameBuilding.length) ? sameBuilding : (nearby && nearby.length ? nearby : []);
  if (!appraisalValue || !ratios.length) return { price: null, ratioPct: null, basis: '' };
  const r = median(ratios)!;
  const ratioPrice = Math.round(appraisalValue * r / 100);
  const which = (sameBuilding && sameBuilding.length) ? `동일건물 낙찰가율 ${ratios.length}건` : `인근 낙찰가율 ${ratios.length}건`;
  // 최저가가 이미 낮아 비율 기반 예상가가 현실을 벗어난 경우(최저가 × 1.5 이하로 cap)
  if (minBidPrice && minBidPrice > 0 && ratioPrice > minBidPrice * 1.5) {
    const cappedPrice = Math.round(minBidPrice * 1.3);
    return { price: cappedPrice, ratioPct: Math.round(r), basis: `${which} 중앙값 ${Math.round(r)}%(최저가 기준 1.3배로 조정)` };
  }
  return { price: ratioPrice, ratioPct: Math.round(r), basis: `${which} 중앙값 ${Math.round(r)}%` };
}

/**
 * 총취득비용 산정에 쓸 '가정 낙찰가' 결정(순수):
 *  - 예상낙찰가가 현 최저가 이상이면 그 값
 *  - 예상낙찰가 없고 최저가가 시세의 5% 미만(극단적 유찰)이면 시세×80% 보수추정
 *    (극단적으로 낮은 최저가를 그대로 쓰면 trueSafetyMargin이 허위로 95%+가 되는 것 방지)
 *  - 그 외 현 회차 최저매각가
 */
export function decideBidForCost(
  expectedBidPrice: number | null, expectedBidBasis: string, minBidPrice: number, marketPrice: number | null,
): { bidForCost: number; bidBasis: string } {
  if (expectedBidPrice && expectedBidPrice >= minBidPrice) {
    return { bidForCost: expectedBidPrice, bidBasis: `예상낙찰가(${expectedBidBasis})` };
  }
  if (!expectedBidPrice && marketPrice && minBidPrice < marketPrice * 0.05) {
    return { bidForCost: Math.round(marketPrice * 0.8), bidBasis: '시세×80% 보수 추정(최저가<시세 5% — 극단적 유찰, ratio 미확보)' };
  }
  return { bidForCost: minBidPrice, bidBasis: '현 회차 최저매각가' };
}

// ───────────────────── 토지이용 규제 flags ─────────────────────

interface FlagDef { re: RegExp; label: string; kind: LandUseFlag['kind']; severity: LandUseFlag['severity']; impact: string }
const FLAG_DEFS: FlagDef[] = [
  { re: /토지거래(계약)?(에\s*관한)?\s*허가구역/, label: '토지거래허가구역(경매=허가배제)', kind: 'opportunity', severity: 'high',
    impact: '경매 취득은 토지거래허가 대상에서 제외(허가 불요) → 일반매매와 달리 실거주의무·전매제한 없이 곧바로 임대 가능. 동일 입지에서 경매 취득의 상대적 우위.' },
  { re: /재개발|재건축|정비구역|주택재(개발|건축)|도시환경정비/, label: '정비구역/재개발', kind: 'opportunity', severity: 'high',
    impact: '입주권 기대 호재이나 권리산정기준일 이후 취득 시 현금청산 위험(조합원 입주권 불가)·분담금 부담 공존. 관리처분 이후 조합원 지위 승계 여부 필수 확인.' },
  { re: /지구단위계획구역/, label: '지구단위계획구역', kind: 'opportunity', severity: 'medium',
    impact: '용도·높이 등 별도 지침 관리. 보유·임대엔 영향 없고 도시재생·개발 중장기 호재. 신축/대수선 시 지침 적합 필요.' },
  { re: /일반상업지역|중심상업지역|근린상업지역|유통상업지역/, label: '상업지역(주거 매입)', kind: 'opportunity', severity: 'medium',
    impact: '높은 용적률로 토지가치·재건축 사업성 큼. 주거용 매입 시 거주환경(소음·일조)·환금성은 입지 의존. 초소형은 토지지분 작아 프리미엄 제한적.' },
  { re: /과밀억제권역/, label: '과밀억제권역(법인 중과)', kind: 'risk', severity: 'low',
    impact: '개인 1주택 소액 취득엔 영향 없음(1.1% 유지). 법인·다주택 확장 전략 시 취득세 중과·대출규제 트리거.' },
  { re: /교육환경보호구역/, label: '교육환경보호구역', kind: 'info', severity: 'low',
    impact: '학교 인접 유해업종 영업 제한. 주거 보유·임대엔 무영향(학군 측면 약한 호재). 상가 업종 전환 시에만 심의.' },
  { re: /대공방어협조구역/, label: '대공방어협조구역(고도제한)', kind: 'info', severity: 'low',
    impact: '일정 표고 초과 신축 시 군 협의. 기존 아파트 보유·임대엔 무영향. 초고층 재건축 시에만 변수.' },
  { re: /가축사육제한구역/, label: '가축사육제한구역', kind: 'info', severity: 'low',
    impact: '축사 신축 제한 규제. 도심 아파트 투자와 무관(노이즈 항목).' },
  { re: /(?:도로|(?<![가-힣])(?:중로|소로|대로|광로))(?:(?!공원|학교|광장|녹지|주차장|하천|도로|중로|소로|대로|광로)[^\n,]){0,15}저촉(?![^\n,]{0,6}(?:않|아니|없))/, label: '도로 저촉(면적 편입)', kind: 'risk', severity: 'medium',
    impact: '계획도로(중로·소로·대로·광로 등급 포함)에 저촉 → 일부 면적이 도로로 수용될 수 있음. 토지(빌라·단독) 분석 시 면적 손실 위험. ("저촉되지 않음/없음" 부정문, 콤마 너머 타 시설은 제외).' },
  { re: /(?:공원|학교|광장|녹지|주차장|하천)(?:(?!도로|중로|소로|대로|광로|공원|학교|광장|녹지|주차장|하천)[^\n,]){0,15}저촉(?![^\n,]{0,6}(?:않|아니|없))|도시계획시설(?:(?!도로|중로|소로|대로|광로)[^\n,]){0,12}저촉(?![^\n,]{0,6}(?:않|아니|없))/, label: '도시계획시설 저촉(공원/학교 등)', kind: 'risk', severity: 'medium',
    impact: '공원·학교·광장 등 도시계획시설에 저촉 → 해당 면적 수용·건축제한 가능. 토지(빌라·단독) 분석 시 면적 손실·활용 제약 위험. ("…에 저촉됨/저촉되는 부분" 풀어쓴 표기 포함, 부정문 제외).' },
  { re: /통제보호구역/, label: '통제보호구역(건축 사실상 불가)', kind: 'risk', severity: 'high',
    impact: '군사분계선 인접·시설 최외곽 매우 근접 구역으로 건축이 사실상 불가하고 강한 통제. 활용도·환금성 크게 저하(개발제한구역에 준하는 제약).' },
  { re: /(?!.*통제보호구역)(?:군사기지|군사시설보호구역|제한보호구역|비행안전구역)/, label: '군사시설보호구역/제한보호·비행안전(신축 시 군 협의)', kind: 'info', severity: 'low',
    impact: '신축·증축·고도 시 군 협의 대상이나 허가 가능. 기존 아파트 보유·임대엔 무영향, 재건축·신축 시에만 협의·고도제한 변수(대공방어협조구역과 동급). 통제보호구역이면 위 high flag로 별도 분류(중복 발화 억제).' },
  { re: /농업진흥구역|농업보호구역|농업진흥지역|농림지역|절대농지|과수원|지목[\s:]*[(\[][전답][)\]]/, label: '농업용도지역(농업진흥·보호/농림)', kind: 'risk', severity: 'medium',
    impact: '농업진흥·보호구역/농림지역 등 농업용 용도지역 → 건축·전용 제약, 주거용 개발·활용 제한. 비도시 농지 물건에서만 변수. 지목이 전·답·과수원이면 농지취득자격증명(농취증)이 필요할 수 있어 권리분석 농취증 항목·토지이용계획확인원으로 확인(지목 자체 탐지는 권리엔진 nongchi 경로가 담당).' },
  { re: /자연녹지지역|생산녹지지역|보전녹지지역/, label: '녹지지역(주거 부적합)', kind: 'risk', severity: 'medium',
    impact: '낮은 용적률·건축 제한으로 주거 개발 부적합. 시세·환금성 입지 의존, 신축·재건축 사업성 제한.' },
  { re: /문화재보호구역|역사문화환경|매장문화재/, label: '문화재보호구역/역사문화환경', kind: 'risk', severity: 'medium',
    impact: '현상변경 허가 필요·매장문화재 발굴조사 가능성. 신축·증축 시 절차 지연·비용. 기존 보유엔 영향 적으나 개발 변수.' },
  { re: /보전산지|임업용산지|공익용산지|보전관리지역|자연환경보전지역/, label: '보전산지/보전관리·자연환경보전', kind: 'risk', severity: 'high',
    impact: '개발·전용에 강한 제한(임업용·공익용 산지, 보전관리·자연환경보전지역). 건축·활용도·환금성 크게 저하.' },
  { re: /상수원보호구역|수변구역|수질보전특별대책지역|(?:수질|상수원)[^,\n]{0,10}특별대책지역|특별대책지역\s*\(?\s*[12]\s*권역/, label: '상수원보호구역/수질보전특별대책', kind: 'risk', severity: 'high',
    impact: '건축·행위에 강한 제한(상수원보호구역, 수질보전 특별대책지역, 수계 수변구역). 신축·증축·용도변경 제약 커 활용도·환금성 저하. 기존 아파트 보유·임대 자체엔 영향이 적을 수 있으나 비도시·상수원 상류 입지에선 개발·전용 변수 큼(대기보전 특별대책지역은 제외).' },
  { re: /개발제한구역|그린벨트/, label: '개발제한구역(그린벨트)', kind: 'risk', severity: 'high',
    impact: '건축·개발 강한 제한. 환금성·활용도 크게 저하.' },
];

/** 토지이용계획 원문 → 투자 위험/기회 flags */
export function classifyLandUseFlags(landUseText: string | undefined): LandUseFlag[] {
  if (!landUseText) return [];
  const out: LandUseFlag[] = [];
  for (const d of FLAG_DEFS) {
    const m = landUseText.match(d.re);
    if (m) out.push({ keyword: m[0], label: d.label, kind: d.kind, severity: d.severity, impact: d.impact });
  }
  return out;
}

// ───────────────────── 총취득비용 오케스트레이터 ─────────────────────

export interface ComputeAcqInput {
  propertyType: PropertyType;
  address: string;
  areaM2?: number; // 전용면적
  bidPrice: number; // 가정 낙찰가(과세표준)
  bidBasis: string;
  gongPrice?: number; // 공동주택공시가격(채권 base)
  moveOutCost?: number; // 사이트 표기 명도비(원). 없으면 면적식 추정.
  assumedAmount: number; // 권리 인수금액
  marketPrice: number | null; // 시세
  etcCost?: number;
  taxOptions?: AcqTaxOptions;
}

export function computeAcquisitionCost(inp: ComputeAcqInput): AcquisitionCost {
  const notes: string[] = [];
  const tax = acquisitionTaxRate(inp.propertyType, inp.bidPrice, inp.areaM2 ?? 0, inp.taxOptions);
  notes.push(`취득세 ${tax.totalRatePct}%: ${tax.note}`);

  const pyeong = inp.areaM2 ? m2ToPyeong(inp.areaM2) : 0;
  const moveOutCost = inp.moveOutCost ?? estimateMoveOutCost(pyeong);
  if (inp.moveOutCost == null) notes.push(`명도비 면적식 추정(${pyeong.toFixed(1)}평) — 사이트 표기값 없음`);

  const bond = estimateHousingBondCost(inp.gongPrice ?? 0, bondRegionFromAddress(inp.address));
  if (bond.faceAmount > 0) notes.push(`국민주택채권 매입 ${won(bond.faceAmount)} → 즉시매도 본인부담 ~${won(bond.ownCost)}(할인율 14% 가정, 등기시점 재확인)`);
  else if (!inp.gongPrice) notes.push('채권: 공시가격 미확보로 0 처리');

  const etcCost = inp.etcCost ?? 0;
  const totalCost = inp.bidPrice + tax.totalKRW + moveOutCost + bond.ownCost + inp.assumedAmount + etcCost;
  const trueSafetyMargin = inp.marketPrice && inp.marketPrice > 0 ? round5((inp.marketPrice - totalCost) / inp.marketPrice) : null;

  return {
    bidPrice: inp.bidPrice, bidBasis: inp.bidBasis,
    acqTax: tax.totalKRW, acqTaxRatePct: tax.totalRatePct,
    moveOutCost, bondCost: bond.ownCost, assumedAmount: inp.assumedAmount, etcCost,
    totalCost, trueSafetyMargin, notes,
  };
}
