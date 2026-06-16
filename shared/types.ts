/**
 * 공용 도메인 타입 — 크롤러 · 분석 파이프라인 · 대시보드가 공유한다.
 *
 * 날짜는 전부 ISO `YYYY-MM-DD` 문자열로 다룬다(권리분석은 "일자 비교"가 핵심이라
 * 시/분 단위 타임존 혼동을 피하기 위함). 대항력의 '익일 0시' 규칙은 날짜 단위로 처리한다.
 */

// ─────────────────────────────────────────────────────────────────
// 매물 (listings)
// ─────────────────────────────────────────────────────────────────

export type PropertyType = 'apartment' | 'villa' | 'officetel' | 'house' | 'land' | 'commercial' | 'other';

export type CrawlSource = 'deonakchal' | 'courtauction';

/** 매물 마스터 — 한 사건/물건의 기본 정보 */
export interface Listing {
  caseNo: string; // 사건번호, 예: "2024타경12345"
  itemNo?: string; // 물건번호 (한 사건에 여러 물건)
  court: string; // 관할법원, 예: "서울중앙지방법원"
  address: string; // 소재지 (지번/도로명)
  roadAddress?: string;
  lat?: number;
  lng?: number;
  propertyType: PropertyType;
  appraisalValue: number; // 감정가 (원)
  minBidPrice: number; // 최저매각가 (원)
  minBidRatio?: number; // 최저가/감정가 (%)
  failCount: number; // 유찰 횟수
  saleDate?: string; // 매각기일 (ISO)
  demandDeadline?: string; // 배당요구종기 (ISO)
  areaM2?: number; // 전용/대지 면적 (㎡)
  buildingAreaM2?: number;
  isCollectiveBuilding?: boolean; // 집합건물 여부(아파트/오피스텔 등) → 토지 등기부 별도 확인 필요
  source: CrawlSource;
  sourceUrl?: string;
  rawJson?: unknown; // 원본 스냅샷
  crawledAt: string; // ISO datetime
}

/** 매물에 딸린 문서/원천 (권리분석 입력) */
export type DocType =
  | 'rights_summary' // 사이트가 제공하는 권리분석 요약
  | 'registry_summary' // 등기 요약(갑구/을구)
  | 'sale_statement' // 매각물건명세서
  | 'survey_report' // 현황조사서
  | 'appraisal_report' // 감정평가서
  | 'site_metrics' // 상세페이지 부가요소(역세권/매각기일/동일건물 실거래/매각가율/표제부/명도비/토지규제)
  | 'registry_pdf'; // 사용자 업로드 등기부등본 PDF

// ─────────────────────────────────────────────────────────────────
// 상세페이지 부가 요소 (site_metrics doc 의 parsed_json)
// ─────────────────────────────────────────────────────────────────

/** 역세권: 노선·역명·도보거리(m) */
export interface TransitStation {
  line: string; // 예: "5호선"
  station: string; // 예: "장한평"
  distanceM: number;
}

/** 매각기일 차수표 한 줄 */
export interface SaleRound {
  round: number; // 1차/2차…
  date: string; // ISO
  minPrice: number; // 해당 회차 최저매각가(원)
  ratioPct?: number; // 감정가 대비 %
}

/** 사이트가 제시한 동일건물/동일면적 실거래 한 건 */
export interface SiteComparable {
  name: string; // 단지/건물명
  areaM2: number; // 전용면적
  pyeong?: number;
  dealYm: string; // 계약년월 YYYY-MM
  dealManwon: number; // 거래금액(만원)
  perPyeongManwon?: number; // ㎡당? 페이지 표기상 평당/㎡당 만원
  floor?: number;
}

/** 건축물 표제부 요약 */
export interface BuildingInfo {
  mainUse?: string; // 주용도
  households?: number; // 세대수
  approvalDate?: string; // 사용승인일 ISO
  floorsAbove?: number;
  floorsBelow?: number;
  far?: number; // 용적률 %
  bcr?: number; // 건폐율 %
}

/** 토지이용 규제 플래그(투자 위험/기회) */
export interface LandUseFlag {
  keyword: string;
  label: string;
  kind: 'risk' | 'opportunity' | 'info';
  severity: 'high' | 'medium' | 'low';
  impact?: string;
}

/** 취득비용 내역 + 진짜 안전마진 */
export interface AcquisitionCost {
  bidPrice: number; // 가정 낙찰가(예상낙찰가 또는 최저가)
  bidBasis: string; // 낙찰가 산정 근거
  acqTax: number; // 취득세+농특세+교육세
  acqTaxRatePct: number;
  moveOutCost: number; // 명도비
  bondCost: number; // 국민주택채권 본인부담(추정)
  assumedAmount: number; // 권리 인수금액
  etcCost: number; // 기타(기본 0)
  totalCost: number; // 총 취득비용
  trueSafetyMargin: number | null; // (시세 − 총취득비용)/시세
  notes: string[];
}

/** 입찰 전 반드시 확인할 사항(법률문서 스캔 결과) */
export interface PreBidItem {
  id: string;
  label: string;
  category: '등기인수' | '임차인배당' | '물건하자' | '공법규제' | '절차비용';
  severity: 'danger' | 'warn' | 'info';
  detail: string; // 무엇이 왜 문제/확인대상인지
  source: string; // 탐지 근거 문서(등기현황/매각물건명세서/현황조사서/감정평가요항/예상배당/토지규제/목록)
  verify?: string; // 더블체크 방법(어느 공부서류/기관)
}

/** 초보자용 용어 풀이 */
export interface GlossaryEntry {
  term: string;
  easy: string; // 초보자 눈높이 설명
  why: string; // 왜 중요한지
  category: string;
}

/** 법령 근거 기반 리스크 평가 한 요소 */
export interface LegalRiskFactor {
  label: string;
  itemRisk: 'manageable' | 'caution' | 'severe';
  laws: { name: string; article?: string; gist: string }[]; // 근거 법령(법제처)
  action?: string; // 초보자 대응
}

/** 매물 종합 법적 리스크 평가 */
export interface LegalRisk {
  grade: 'manageable' | 'caution' | 'severe' | 'avoid';
  manageable: boolean; // 개인 투자자가 감당할 만한가
  headline: string;
  reasoning: string;
  factors: LegalRiskFactor[];
}

/** 보유기간별 세후 매도 시나리오 */
export interface SaleScenario {
  holdYears: number;
  yangdoTax: number; // 양도세+지방세(원)
  ltdRate: number; // 장기보유특별공제율
  netCashProfit: number; // 실현 세후 순익(원)
  effRatePct: number; // 양도세 실효세율(차익 대비 %)
}

/** 임대수익·출구 분석 */
export interface IncomeAnalysis {
  rentBasis: string;
  jeonseDeposit: number | null;
  monthlyDeposit: number | null;
  monthlyRent: number | null;
  jeonseRatioPct: number | null; // 전세가율 %
  gapInvestment: number | null; // 갭(전세 끼고 실투자, 원)
  grossYieldPct: number | null; // 월세 표면수익률 %
  monthlyCashflow: number | null; // 월 순현금흐름(원)
  cashflowNote: string;
  hiddenTenantDeposit: number | null; // 점유 임차인 보증금 추정(원)
  saleScenarios: SaleScenario[];
  notes: string[];
  estimated?: boolean; // 전월세 실거래 미확보 → 전세가율 가정으로 추정(저신뢰)
}

/** 명도 난이도·인도명령·비용/기간 분석 */
export interface EvictionAnalysis {
  occupantLabel: string; // 점유자 유형(한글)
  remedy: 'WRIT' | 'LAWSUIT' | 'WRIT_THEN_LAWSUIT'; // 인도명령 / 명도소송 / 인도명령후소송
  remedyLabel: string;
  writEligible: boolean; // 인도명령 가능 여부
  difficulty: 'easy' | 'medium' | 'hard';
  costLow: number; costBase: number; costHigh: number; // 명도 비용 레인지(원)
  monthsLow: number; monthsHigh: number; // 예상 소요기간(개월)
  reason: string;
  negotiationBrief: string; // 협상 레버리지 브리프
  laws: { name: string; article?: string }[];
  notes: string[];
}

/** 발품-절감 리포트: 원격으로 끝난 것 / 현장에 남은 것 */
export interface FieldworkReport {
  remoteDone: { label: string; ok: boolean }[]; // 원격 분석 완료 현황
  fieldChecklist: { label: string; why: string }[]; // 현장 가서 확인할 것(이 매물 맞춤)
  legworkSavedPct: number; // 발품 절감 추정 %
}

/** 매물별 종합 보고서 */
export interface ListingReport {
  headline: string; // 한 줄 결론
  recommendation: 'consider' | 'caution' | 'avoid';
  summary: string[]; // 핵심 지표 bullet
  rightsSummary: string;
  locationSummary: string;
  costSummary: string;
  checklist: PreBidItem[]; // 입찰 전 필수 확인사항
  dangerCount: number;
  warnCount: number;
  sourceUrl?: string; // 원본 상세페이지(더블체크용)
  glossary?: GlossaryEntry[]; // 이 매물에 등장한 용어 풀이(초보자용)
  legalRisk?: LegalRisk; // 법령 근거 리스크 평가
  fieldwork?: FieldworkReport; // 발품-절감 리포트 + 현장 체크리스트
}

export interface SiteMetrics {
  transit?: TransitStation[];
  saleRounds?: SaleRound[];
  siteComps?: SiteComparable[];
  nearbySaleRatios?: number[]; // 인근 매각가율(낙찰/감정 %)
  sameBuildingSaleRatios?: number[]; // 동일 건물명 매각가율
  building?: BuildingInfo;
  moveOutCost?: number; // 사이트 표기 명도비(원)
  pageAcqTaxPct?: number; // 사이트 표기 취득세율
  landUseText?: string; // 토지이용계획 원문
  landUseFlags?: LandUseFlag[];
  adminOffices?: Record<string, string>; // 법원/등기소/세무서/주민센터
  photos?: string[]; // 매물 사진 URL(감정평가 현황 사진 등)
}

export interface ListingDoc {
  caseNo: string;
  itemNo?: string;
  docType: DocType;
  parsedJson?: unknown;
  pdfPath?: string; // Supabase Storage 경로
}

// ─────────────────────────────────────────────────────────────────
// 권리분석 입력 (등기 원장 + 임차인 + 명세서)
// ─────────────────────────────────────────────────────────────────

/**
 * 등기 권리 종류. 말소기준권리 후보는 isMalsoCandidate()로 판별.
 */
export type RightKind =
  | 'geunjeodang' // 근저당권
  | 'jeodang' // 저당권
  | 'apryu' // 압류
  | 'gaapryu' // 가압류
  | 'dambo_gadeungi' // 담보가등기
  | 'gyeongmae_gaesi' // 경매개시결정등기
  | 'jeonse' // 전세권
  | 'bowjeon_gadeungi' // 보전가등기(소유권이전청구권 가등기)
  | 'imchagwon' // 주택임차권등기
  | 'jisangwon' // 지상권
  | 'jiyeokgwon' // 지역권
  | 'hwanmae' // 환매특약등기
  | 'gacheobun' // 가처분
  | 'cheolgeo_gacheobun' // 건물철거 및 토지인도 가처분 (순위 무관 인수)
  | 'sintak' // 신탁
  | 'soyugwon' // 소유권이전(참고용)
  | 'other';

/** 등기부 한 줄(권리) */
export interface RegistryEntry {
  /** 순위번호 (갑구/을구 내 등기 순위) */
  rankNo?: number;
  /** 등기 구분 */
  section?: 'gabgu' | 'eulgu'; // 갑구(소유권 관련) / 을구(소유권 외)
  kind: RightKind;
  /** 권리자 (개인정보 — 분석엔 불필요하면 마스킹) */
  holder?: string;
  /** 채권최고액/설정액 (원). 근저당권은 채권최고액. */
  amount?: number;
  /** 접수일자 (ISO) — 순위 판단의 1차 기준 */
  receiptDate: string;
  /** 접수번호 — 같은 날짜일 때 순위 판단 */
  receiptNo?: number;
  /** 배당요구 여부 (전세권 등 일부 권리의 소멸/인수 판단에 사용) */
  demandedDistribution?: boolean;
  /** 원본 텍스트 */
  raw?: string;
}

/** 임차인 (매각물건명세서 점유자 현황 + 현황조사서) */
export interface Tenant {
  name?: string; // 개인정보 — 마스킹 가능
  /** 점유 시작일 (ISO) */
  occupancyDate?: string;
  /** 전입신고일 (ISO) — 대항력 요건 */
  moveInDate?: string;
  /** 확정일자 (ISO) — 우선변제권 요건 */
  fixedDate?: string;
  /** 보증금 (원) */
  deposit: number;
  /** 월차임 (원) */
  monthlyRent?: number;
  /** 배당요구 여부 */
  demandedDistribution: boolean;
  /** 배당요구 일자 (ISO) — 종기 이내 여부 검증 */
  demandDate?: string;
  /** 실제 점유 여부 */
  occupied: boolean;
  raw?: string;
}

/** rule engine 입력 묶음 */
export interface RightsInput {
  listing: Pick<
    Listing,
    'caseNo' | 'court' | 'address' | 'minBidPrice' | 'appraisalValue' | 'demandDeadline' | 'isCollectiveBuilding'
  >;
  /** 건물 등기 권리 원장 */
  registry: RegistryEntry[];
  /** 집합건물의 경우 토지 등기 별도(있으면) */
  landRegistry?: RegistryEntry[];
  tenants: Tenant[];
  /** 매각물건명세서의 "최선순위 설정일자"(교차검증용, ISO) */
  statementSeniorDate?: string;
  /** 비고/특이사항 텍스트 (레드플래그 스캔 대상) */
  notes?: string[];
}

// ─────────────────────────────────────────────────────────────────
// 권리분석 출력
// ─────────────────────────────────────────────────────────────────

export type Disposition = 'extinguished' | 'assumed'; // 소멸 / 인수

export interface ClassifiedRight {
  entry: RegistryEntry;
  disposition: Disposition;
  /** 인수/소멸 판단 근거(한국어 설명) */
  reason: string;
}

export interface TenantAnalysis {
  tenant: Tenant;
  /** 대항력 발생일 (ISO) = max(점유, 전입)+1일. 요건 미충족 시 null */
  oppositionDate: string | null;
  /** 대항력 유무 (말소기준권리보다 선순위) */
  hasOpposition: boolean;
  /** 우선변제권 유무 (확정일자 + 대항요건) */
  hasPriorityRepayment: boolean;
  /** 우선변제권 발생일 (ISO) */
  priorityDate: string | null;
  /** 최우선변제(소액임차인) 해당 여부 */
  isSmallTenant: boolean;
  /** 최우선변제 가능액 (원) */
  minPriorityAmount: number;
  /** 배당요구 종기 내 적법 배당요구 여부 */
  validDemand: boolean;
  notes: string[];
}

export type RedFlagKind =
  | 'yuchigwon' // 유치권
  | 'beopjeong_jisangwon' // 법정지상권(여지)
  | 'bunmyo_gijigwon' // 분묘기지권
  | 'daejigwon_mideungi' // 대지권 미등기
  | 'toji_byeoldo_deungi' // 토지별도등기
  | 'jesioe_building' // 제시외 건물
  | 'nongchi' // 농지취득자격증명 필요
  | 'senior_tenant' // 선순위 대항력 임차인(인수 위험)
  | 'senior_gadeungi' // 선순위 가등기
  | 'cheolgeo_gacheobun'; // 건물철거 가처분

export interface RedFlag {
  kind: RedFlagKind;
  severity: 'info' | 'warn' | 'danger';
  message: string;
  /** 사람(변호사/법무사) 검토 필요 여부 */
  needsHumanReview: boolean;
}

export interface DistributionLine {
  rank: number;
  label: string; // 예: "최우선변제(소액임차인)", "1순위 근저당", "확정일자부 임차인"
  claimant?: string;
  amount: number; // 배당액 (원)
  basis: string;
}

export interface RightsAnalysisResult {
  caseNo: string;
  /** 말소기준권리 */
  malsoBasis: {
    entry: RegistryEntry | null;
    date: string | null; // ISO
    note: string;
  };
  classified: ClassifiedRight[];
  tenants: TenantAnalysis[];
  distribution: DistributionLine[];
  /** 낙찰자가 추가로 인수해야 하는 총액 (원) */
  assumedAmount: number;
  /** 인수 항목 내역 */
  assumedBreakdown: { label: string; amount: number; reason: string }[];
  /** 최대 안전 입찰가 = (목표상한) − 인수금액 − 여유. 엔진은 minBidPrice 기준 참고선 제시 */
  maxSafeBid: number | null;
  redFlags: RedFlag[];
  /** 종합 위험등급 */
  riskGrade: 'clean' | 'caution' | 'risky' | 'review_required';
  /** 권리관계 깨끗(인수 0 & danger 플래그 없음) 여부 */
  isClean: boolean;
  warnings: string[];
  /** 엔진 버전 (감사 추적) */
  engineVersion: string;
}

// ─────────────────────────────────────────────────────────────────
// 입지분석 / 점수 (요약 — 상세는 pipeline/location, pipeline/select)
// ─────────────────────────────────────────────────────────────────

export interface Comparable {
  apartmentName?: string;
  dong?: string; // 법정동(예: 천호동)
  areaM2: number;
  dealAmount: number; // 실거래가 (원)
  dealDate: string; // ISO
  floor?: number;
  buildYear?: number;
  distanceM?: number;
}

export interface LocationAnalysis {
  caseNo: string;
  marketPrice: number | null; // 추정 시세 (원)
  comps: Comparable[];
  /** 시세 추정 신뢰도 (비교군 매칭 수준) */
  marketConfidence?: 'high' | 'medium' | 'low' | null;
  /** 비교군 선정 근거(예: "천호동·면적 매칭 7건") */
  compBasis?: string;
  /** 안전마진 = (시세 − 최저매각가) / 시세 */
  safetyMargin: number | null;
  transit?: { nearestStation?: string; walkMinutes?: number; lines?: number; stations?: TransitStation[] };
  schools?: { assignedElementary?: string; assignedMiddle?: string; academyCount?: number; schoolCount?: number };
  amenities?: Record<string, number>; // 카테고리별 반경 내 개수
  devSignals?: string[];

  // ── 상세페이지 부가요소 기반 확장 ──
  /** 예상낙찰가(감정가 × 낙찰가율) */
  expectedBidPrice?: number | null;
  expectedBidBasis?: string;
  /** 총취득비용(취득세+명도비+채권+인수금액 포함) + 진짜 안전마진 */
  acquisitionCost?: AcquisitionCost;
  /** 사이트 동일건물 실거래 비교군 */
  siteComps?: SiteComparable[];
  /** 매각기일 차수표 */
  saleRounds?: SaleRound[];
  /** 건축물 표제부 */
  building?: BuildingInfo;
  /** 토지이용 규제 플래그 */
  landUseFlags?: LandUseFlag[];
  /** 관할 행정기관 */
  adminOffices?: Record<string, string>;
  /** 매물 사진 URL */
  photos?: string[];
  /** 임대수익·출구 분석 */
  income?: IncomeAnalysis;
  /** 명도 난이도 분석 */
  eviction?: EvictionAnalysis;
  /** 매물별 종합 보고서 + 입찰 전 체크리스트 */
  report?: ListingReport;
}

export interface Score {
  caseNo: string;
  safetyMarginScore: number; // 0~100
  cleanRightsScore: number; // 0~100
  totalScore: number; // 가중합
  passedFilter: boolean;
  reason: string;
}
