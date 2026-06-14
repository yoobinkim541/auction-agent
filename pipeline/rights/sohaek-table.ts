/**
 * 소액임차인 최우선변제 기준표 (주택임대차보호법 시행령 제10조·제11조)
 *
 * ⚠️ 중요: 적용 기준은 "임차 시점"이 아니라 **담보물권(근저당 등) 최초 설정일**이다.
 *   (대법원 2001다84824 등 — 시행령 부칙: 개정 전 설정된 담보물권에는 종전 규정 적용)
 *
 * ⚠️ 정확성: 아래 수치는 널리 인용되는 시행령 개정 연혁을 코드화한 것이다.
 *   실제 운용 전 반드시 법제처 국가법령정보센터(open.law.go.kr)의 현행/연혁 시행령과
 *   대조·검증할 것. 금액 단위는 '원'.
 *
 * 지역 구분(tier):
 *   - seoul      : 서울특별시
 *   - overcrowded: 수도권정비계획법상 과밀억제권역(서울 제외) (+ 일부 개정에서 세종/용인/화성/김포 등 추가)
 *   - metro      : 광역시(군 제외) + 일부 시(안산/광주/파주/이천/평택 등, 개정별 상이)
 *   - other      : 그 밖의 지역
 */

export type RegionTier = 'seoul' | 'overcrowded' | 'metro' | 'other';

export interface SohaekBracket {
  /** 보증금 상한(이하여야 소액임차인) */
  ceiling: number;
  /** 최우선변제 금액(상한) */
  maxPriority: number;
}

export interface SohaekVersion {
  /** 이 기준이 적용되는 담보물권 설정일 하한 (ISO, 포함) */
  effectiveFrom: string;
  brackets: Record<RegionTier, SohaekBracket>;
  /** 법제처 대조용 메모 */
  note?: string;
}

const 만 = 10_000;

/**
 * 최신이 위로 오도록 effectiveFrom 내림차순 정렬 유지.
 * lookup은 "설정일 >= effectiveFrom" 인 첫(가장 최신) 버전을 고른다.
 */
export const SOHAEK_TABLE: SohaekVersion[] = [
  {
    effectiveFrom: '2023-02-21',
    brackets: {
      seoul: { ceiling: 16_500 * 만, maxPriority: 5_500 * 만 },
      overcrowded: { ceiling: 14_500 * 만, maxPriority: 4_800 * 만 },
      metro: { ceiling: 8_500 * 만, maxPriority: 2_800 * 만 },
      other: { ceiling: 7_500 * 만, maxPriority: 2_500 * 만 },
    },
    note: '2023.2.21 개정(현행). overcrowded에 세종·용인·화성·김포 포함; metro에 안산·광주·파주·이천·평택 포함.',
  },
  {
    effectiveFrom: '2021-05-11',
    brackets: {
      seoul: { ceiling: 15_000 * 만, maxPriority: 5_000 * 만 },
      overcrowded: { ceiling: 13_000 * 만, maxPriority: 4_300 * 만 },
      metro: { ceiling: 7_000 * 만, maxPriority: 2_300 * 만 },
      other: { ceiling: 6_000 * 만, maxPriority: 2_000 * 만 },
    },
  },
  {
    effectiveFrom: '2018-09-18',
    brackets: {
      seoul: { ceiling: 11_000 * 만, maxPriority: 3_700 * 만 },
      overcrowded: { ceiling: 10_000 * 만, maxPriority: 3_400 * 만 },
      metro: { ceiling: 6_000 * 만, maxPriority: 2_000 * 만 },
      other: { ceiling: 5_000 * 만, maxPriority: 1_700 * 만 },
    },
    note: 'overcrowded에 세종·용인·화성 포함; metro에 안산·김포·광주·파주 포함.',
  },
  {
    effectiveFrom: '2016-03-31',
    brackets: {
      seoul: { ceiling: 10_000 * 만, maxPriority: 3_400 * 만 },
      overcrowded: { ceiling: 8_000 * 만, maxPriority: 2_700 * 만 },
      metro: { ceiling: 6_000 * 만, maxPriority: 2_000 * 만 },
      other: { ceiling: 5_000 * 만, maxPriority: 1_700 * 만 },
    },
  },
  {
    effectiveFrom: '2014-01-01',
    brackets: {
      seoul: { ceiling: 9_500 * 만, maxPriority: 3_200 * 만 },
      overcrowded: { ceiling: 8_000 * 만, maxPriority: 2_700 * 만 },
      metro: { ceiling: 6_000 * 만, maxPriority: 2_000 * 만 },
      other: { ceiling: 4_500 * 만, maxPriority: 1_500 * 만 },
    },
  },
  {
    effectiveFrom: '2010-07-26',
    brackets: {
      seoul: { ceiling: 7_500 * 만, maxPriority: 2_500 * 만 },
      overcrowded: { ceiling: 6_500 * 만, maxPriority: 2_200 * 만 },
      metro: { ceiling: 5_500 * 만, maxPriority: 1_900 * 만 },
      other: { ceiling: 4_000 * 만, maxPriority: 1_400 * 만 },
    },
  },
  {
    // 그 이전(2008-08-21~)의 보수적 폴백
    effectiveFrom: '1900-01-01',
    brackets: {
      seoul: { ceiling: 6_000 * 만, maxPriority: 2_000 * 만 },
      overcrowded: { ceiling: 6_000 * 만, maxPriority: 2_000 * 만 },
      metro: { ceiling: 5_000 * 만, maxPriority: 1_700 * 만 },
      other: { ceiling: 4_000 * 만, maxPriority: 1_400 * 만 },
    },
    note: '2010-07-26 이전 설정분 폴백(근사치). 정확한 적용은 법제처 연혁 확인 필요.',
  },
];

/**
 * 과밀억제권역(서울 제외) — 더낙찰옥션 chart3(과밀억제권역표) 기준:
 *   인천(강화·옹진 등 일부 제외)·의정부·구리·남양주(일부동)·하남·고양·수원·성남·안양·부천·광명·과천·의왕·군포·시흥.
 * + 세종·용인·화성·김포는 과밀억제권역은 아니나 주임법 시행령(2018/2023)에서 소액임차인 '과밀' 구간에 편입되어 포함.
 */
const OVERCROWDED_CITIES = [
  '의정부', '구리', '남양주', '하남', '고양', '수원', '성남', '안양', '부천',
  '광명', '과천', '의왕', '군포', '시흥', '김포', '용인', '화성', '세종',
];
/** metro tier에 포함되는 광역시 + 일부 시 */
const METRO_KEYWORDS = ['부산', '대구', '대전', '울산', '광주광역시', '안산', '파주', '이천', '평택'];

/** 주소 문자열 → 지역 tier 분류 (근사). 불확실하면 가장 가까운 보수적 tier. */
export function classifyRegionTier(address: string): { tier: RegionTier; certain: boolean } {
  const a = address.replace(/\s/g, '');
  if (a.startsWith('서울') || a.includes('서울특별시')) return { tier: 'seoul', certain: true };
  if (a.startsWith('인천') || a.includes('인천광역시')) return { tier: 'overcrowded', certain: false };
  if (OVERCROWDED_CITIES.some((c) => a.includes(c))) return { tier: 'overcrowded', certain: false };
  if (METRO_KEYWORDS.some((c) => a.includes(c))) return { tier: 'metro', certain: false };
  // 광주광역시 vs 경기 광주시 구분 주의
  if ((a.includes('부산') || a.includes('대구') || a.includes('대전') || a.includes('울산'))) {
    return { tier: 'metro', certain: false };
  }
  return { tier: 'other', certain: false };
}

/** 담보물권 설정일에 해당하는 시행령 버전 선택 */
export function pickSohaekVersion(securityDate: string): SohaekVersion {
  for (const v of SOHAEK_TABLE) {
    if (securityDate >= v.effectiveFrom) return v;
  }
  return SOHAEK_TABLE[SOHAEK_TABLE.length - 1]!;
}

export interface SohaekResult {
  isSmallTenant: boolean;
  maxPriority: number; // 최우선변제 가능액(보증금/상한 중 작은 값)
  ceiling: number;
  tier: RegionTier;
  tierCertain: boolean;
  versionFrom: string;
}

/**
 * 소액임차인 판정.
 * @param deposit 보증금(원)
 * @param address 소재지(지역 tier 판정)
 * @param firstSecurityDate 담보물권(근저당 등) 최초 설정일 ISO. 없으면 경매개시일 등 기준일.
 */
export function evaluateSohaek(
  deposit: number,
  address: string,
  firstSecurityDate: string,
): SohaekResult {
  const { tier, certain } = classifyRegionTier(address);
  const version = pickSohaekVersion(firstSecurityDate);
  const bracket = version.brackets[tier];
  const isSmallTenant = deposit <= bracket.ceiling;
  // 최우선변제액은 보증금 전액과 상한 중 작은 값(배당재원 1/2 한도는 배당 시뮬에서 별도 적용)
  const maxPriority = isSmallTenant ? Math.min(deposit, bracket.maxPriority) : 0;
  return {
    isSmallTenant,
    maxPriority,
    ceiling: bracket.ceiling,
    tier,
    tierCertain: certain,
    versionFrom: version.effectiveFrom,
  };
}
