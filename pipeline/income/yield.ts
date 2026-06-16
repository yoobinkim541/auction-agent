/**
 * 임대수익·출구(양도세) 엔진 — '이거 사면 돈 되나'를 손품으로 끝낸다.
 *   입력: 시세, 총취득비용(AcquisitionCost), 전월세 시세(RentEstimate)
 *   출력: 전세가율·갭·전세레버리지 실투자금, 월세 수익률·보유 현금흐름,
 *         보유기간별(2/5/10년) 세후 매도 순익(양도세), 숨은 임차인 보증금 추정.
 *
 * ⚠️ 참고용 추정(세무·금융자문 아님). 양도세 다주택 중과·1세대1주택 비과세·조정지역,
 *    경락잔금대출 한도·금리는 실행 시점 홈택스·금융기관 재확인 필요. (도메인 리서치+적대적 검증, 2026.6)
 */
import type { RentEstimate } from './rent.ts';
import type { IncomeAnalysis, SaleScenario } from '../../shared/types.ts';

const EOK = 100_000_000;
const round = (n: number) => Math.round(n);

// ───────────────────────── 양도소득세 (2026.6) ─────────────────────────

interface Bracket { upTo: number; rate: number; deduct: number }
const BASIC_BRACKETS: Bracket[] = [
  { upTo: 14_000_000, rate: 0.06, deduct: 0 },
  { upTo: 50_000_000, rate: 0.15, deduct: 1_260_000 },
  { upTo: 88_000_000, rate: 0.24, deduct: 5_760_000 },
  { upTo: 150_000_000, rate: 0.35, deduct: 15_440_000 },
  { upTo: 300_000_000, rate: 0.38, deduct: 19_940_000 },
  { upTo: 500_000_000, rate: 0.40, deduct: 25_940_000 },
  { upTo: 1_000_000_000, rate: 0.42, deduct: 35_940_000 },
  { upTo: Infinity, rate: 0.45, deduct: 65_940_000 },
];
const BASIC_DEDUCTION = 2_500_000; // 양도소득 기본공제(연 1회)
const LOCAL_TAX = 0.10; // 지방소득세 = 산출세액 × 10%

function basicTax(base: number): number {
  if (base <= 0) return 0;
  const b = BASIC_BRACKETS.find((x) => base <= x.upTo)!;
  return base * b.rate - b.deduct;
}
/** 장기보유특별공제 표1(일반): 3년부터 연 2%, 15년 30% 상한 */
function ltdGeneral(holdYears: number): number {
  if (holdYears < 3) return 0;
  return Math.min(0.30, Math.floor(holdYears) * 0.02);
}

export interface YangdoOptions {
  /** 단기 중과율(1년미만 70%, 1~2년 60%) 적용. 2년 이상이면 누진표. */
  multiHomeSurchargePct?: number; // 조정지역 다주택 중과 +20/+30%p. 기본 0(개인 1주택 가정).
}

/** 보유기간별 양도세 + 세후 순익. salePrice=예상 매도가(시세), totalAcqCost=총취득비용. */
export function saleScenarios(args: {
  salePrice: number;
  bidPrice: number; // 낙찰가(취득가액)
  acqTax: number; // 취득세(필요경비)
  bondCost: number; // 채권 본인부담(필요경비)
  totalAcqCost: number; // 총취득비용(명도비·인수 포함 — 실현순익 계산용)
  holdYearsList?: number[];
  options?: YangdoOptions;
}): SaleScenario[] {
  const { salePrice, bidPrice, acqTax, bondCost, totalAcqCost } = args;
  const surcharge = args.options?.multiHomeSurchargePct ?? 0;
  const saleBroker = Math.round(salePrice * 0.005); // 매도 중개보수 ~0.5%(상한 근사)
  // 필요경비: 취득세·채권·양도중개(취득중개 생략). 명도비·이자·보유세는 불인정.
  const expenses = acqTax + bondCost + saleBroker;
  const rawGain = salePrice - bidPrice - expenses;

  return (args.holdYearsList ?? [2, 5, 10]).map((holdYears) => {
    if (rawGain <= 0) return { holdYears, yangdoTax: 0, ltdRate: 0, netCashProfit: salePrice - totalAcqCost - saleBroker, effRatePct: 0 };
    const ltdRate = surcharge > 0 ? 0 : ltdGeneral(holdYears); // 중과 시 장특공 배제
    const base = Math.max(0, rawGain * (1 - ltdRate) - BASIC_DEDUCTION);
    let tax: number;
    if (holdYears < 1) tax = base * 0.70;
    else if (holdYears < 2) tax = base * 0.60;
    else if (surcharge > 0) { const b = BASIC_BRACKETS.find((x) => base <= x.upTo)!; tax = base * (b.rate + surcharge) - b.deduct; }
    else tax = basicTax(base);
    tax = Math.max(0, Math.round(tax * (1 + LOCAL_TAX)));
    return {
      holdYears, yangdoTax: tax, ltdRate,
      netCashProfit: round(salePrice - totalAcqCost - tax - saleBroker),
      effRatePct: Math.round((tax / rawGain) * 1000) / 10,
    };
  });
}

// ───────────────────────── 임대수익률 ─────────────────────────

export interface IncomeInput {
  marketPrice: number | null;
  totalAcqCost: number | null;
  bidPrice: number;
  acqTax: number;
  bondCost: number;
  gongPrice?: number;
  rent: RentEstimate;
  hasOpposingTenant?: boolean; // 대항력 임차인 존재(숨은 보증금 추정 표기용)
  loanRatePct?: number; // 경락잔금대출 금리 가정(기본 5%)
  mgmtFeeMonthly?: number;
}

export function analyzeIncome(inp: IncomeInput): IncomeAnalysis {
  const notes: string[] = [];
  const market = inp.marketPrice ?? null;
  const total = inp.totalAcqCost ?? null;
  const r = inp.rent;

  // 추정 모드(전세가율 가정)에선 전세가율을 되돌려 보여주는 건 동어반복 → 갭만 노출.
  const jeonseRatioPct = (r.jeonseDeposit && market && !r.estimated) ? Math.round((r.jeonseDeposit / market) * 1000) / 10 : null;
  const gapInvestment = (r.jeonseDeposit && total) ? round(total - r.jeonseDeposit) : null;
  const grossYieldPct = (r.monthlyRent && total) ? Math.round((r.monthlyRent * 12 / total) * 1000) / 10 : null;

  // 월세 보유 현금흐름(가정): 월세 − 대출이자 − 재산세/12 − 관리비
  let monthlyCashflow: number | null = null;
  let cashflowNote = '';
  if (r.monthlyRent && total && market) {
    const rate = (inp.loanRatePct ?? 5.0) / 100;
    const loan = Math.min(6 * EOK, Math.round(market * 0.7)); // LTV 70%·6억 상한 가정
    const interestM = Math.round(loan * rate / 12);
    const propTaxM = inp.gongPrice ? Math.round(inp.gongPrice * 0.001 / 12) : 0; // 재산세 대략 공시가×0.1%/년
    const mgmt = inp.mgmtFeeMonthly ?? 0;
    monthlyCashflow = r.monthlyRent - interestM - propTaxM - mgmt;
    cashflowNote = `월세 ${won(r.monthlyRent)} − 이자(대출 ${eok(loan)}×${(inp.loanRatePct ?? 5).toFixed(1)}%) ${won(interestM)} − 재산세 ${won(propTaxM)}${mgmt ? ` − 관리비 ${won(mgmt)}` : ''}`;
    notes.push('현금흐름은 LTV 70%·금리 5% 가정 — 실제 대출한도/금리는 규제지역·DSR로 달라짐');
  }

  const hiddenTenantDeposit = inp.hasOpposingTenant ? r.jeonseDeposit : null;
  if (hiddenTenantDeposit) notes.push('대항력 임차인 보증금 규모는 전세 시세로 추정 — 실제 인수액은 등기·명세서 확인');

  const scenarios = (market && total) ? saleScenarios({
    salePrice: market, bidPrice: inp.bidPrice, acqTax: inp.acqTax, bondCost: inp.bondCost, totalAcqCost: total,
  }) : [];
  if (scenarios.length) notes.push('매도가는 현재 시세 동결 가정 — 장기보유공제로 보유기간↑일수록 세후 순익↑. 1세대1주택 비과세·다주택 중과는 미반영(개인 1주택 기본세율 가정)');

  if (r.estimated) notes.push('전월세 실거래 미확보 → 전세보증금은 지역·유형 전세가율 가정으로 역산한 추정치(저신뢰). 월세·표면수익률은 산출하지 않음. 실제 임대시세는 인근 중개·실거래 재확인 필요');
  else if (!r.n) notes.push('MOLIT 전월세 실거래 부족 — 임대시세 추정 불가(인근 표본 없음)');

  return {
    rentBasis: r.basis, jeonseDeposit: r.jeonseDeposit, monthlyDeposit: r.monthlyDeposit, monthlyRent: r.monthlyRent,
    jeonseRatioPct, gapInvestment, grossYieldPct, monthlyCashflow, cashflowNote, hiddenTenantDeposit,
    saleScenarios: scenarios, notes, estimated: r.estimated,
  };
}

const won = (n: number) => n.toLocaleString('ko-KR') + '원';
const eok = (n: number) => (n / EOK).toFixed(2) + '억';
