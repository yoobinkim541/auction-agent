/**
 * 명도 난이도 엔진 — 점유 확인·법무사 상담 발품을 대체.
 *   점유유형 판정(권리분석 산출물) → 인도명령(민사집행법 §136) vs 명도소송 → 난이도·비용/기간·협상 브리프.
 *
 * ⚠️ 참고용 추정. 인도명령 인용은 집행법원 재량, 비용은 지역 집행관·인력단가로 ±30% 변동.
 *    불확실 시 보수적(어려운 쪽)으로 분류. 법률자문 아님. (도메인 리서치+적대적 검증, 2026.6)
 */
import type { RightsAnalysisResult, EvictionAnalysis } from '../../shared/types.ts';
import { m2ToPyeong } from '../../shared/units.ts';

type OccupantType = 'OWNER_DEBTOR' | 'TENANT_NO_OPP' | 'TENANT_OPP_PAID' | 'TENANT_OPP_ASSUMED' | 'LIEN' | 'VACANT' | 'UNKNOWN';

const LABEL: Record<OccupantType, string> = {
  OWNER_DEBTOR: '소유자·채무자 점유', TENANT_NO_OPP: '무대항력 임차인', TENANT_OPP_PAID: '대항력 임차인(배당 전액회수)',
  TENANT_OPP_ASSUMED: '대항력 임차인(보증금 인수)', LIEN: '유치권 주장 점유', VACANT: '공실', UNKNOWN: '점유관계 미상',
};
const MJ = '민사집행법';

/** 점유유형 판정 — rights(임차인·인수금액·redFlags) + 명세서 notes */
export function inferOccupantType(rights: RightsAnalysisResult, notes: string[]): OccupantType {
  const text = notes.join(' ');
  if (rights.redFlags.some((f) => f.kind === 'yuchigwon') || /유치권/.test(text)) return 'LIEN';
  const oppTenant = rights.tenants.find((t) => t.hasOpposition);
  if (oppTenant) return rights.assumedAmount > 0 ? 'TENANT_OPP_ASSUMED' : 'TENANT_OPP_PAID';
  if (rights.tenants.length > 0) return 'TENANT_NO_OPP';
  if (/공실|임차인\s*없|폐문부재(?!.*점유)/.test(text)) return 'VACANT';
  if (/소유자\s*점유|채무자\s*(겸\s*소유자\s*)?(거주|점유)|소유자\s*겸\s*채무자/.test(text)) return 'OWNER_DEBTOR';
  return 'UNKNOWN';
}

interface Profile { remedy: EvictionAnalysis['remedy']; remedyLabel: string; writEligible: boolean; difficulty: EvictionAnalysis['difficulty']; costMult: number; monthsLow: number; monthsHigh: number; reason: string; brief: string }
const PROFILES: Record<OccupantType, Profile> = {
  VACANT: { remedy: 'WRIT', remedyLabel: '명도 불요(공실)', writEligible: true, difficulty: 'easy', costMult: 0.2, monthsLow: 0, monthsHigh: 1, reason: '공실 — 점유 회수 절차 사실상 불요(잔존물 정리만).', brief: '공실이라 협상 상대 없음. 잔존물·잠금 정리, 관리비 정산만 확인.' },
  OWNER_DEBTOR: { remedy: 'WRIT', remedyLabel: '인도명령', writEligible: true, difficulty: 'easy', costMult: 1.0, monthsLow: 1, monthsHigh: 3, reason: '소유자·채무자는 매수인에 대항할 권원 없음 → 인도명령 대상(§136①).', brief: '인도명령으로 빠른 회수 가능. 통상 협의 이사비(강제집행 실비의 50~70%)로 자진 퇴거 유도.' },
  TENANT_NO_OPP: { remedy: 'WRIT', remedyLabel: '인도명령', writEligible: true, difficulty: 'easy', costMult: 1.0, monthsLow: 1, monthsHigh: 4, reason: '말소기준권리보다 후순위(무대항력) 임차인 → 임차권 소멸, 인도명령 대상.', brief: '인도명령 대상이나 배당 못 받은 임차인은 저항 가능 → 소액 이사비 협의 권장.' },
  TENANT_OPP_PAID: { remedy: 'WRIT_THEN_LAWSUIT', remedyLabel: '협의(대항력)', writEligible: false, difficulty: 'medium', costMult: 1.1, monthsLow: 1, monthsHigh: 4, reason: '대항력 임차인이나 배당으로 보증금 전액 회수 → 통상 협조적. 단 대항력 있어 인도명령 직접대상 아님.', brief: '보증금 전액 배당받으므로 명도 협조적. 배당 수령(매수인 명도확인서)과 퇴거를 연계해 협상.' },
  TENANT_OPP_ASSUMED: { remedy: 'LAWSUIT', remedyLabel: '명도소송(인수)', writEligible: false, difficulty: 'hard', costMult: 1.6, monthsLow: 6, monthsHigh: 12, reason: '대항력 임차인 + 미회수 보증금 인수 → 인도명령 불가, 보증금 반환해야 명도 가능. 가장 어려움.', brief: '인수 보증금을 반환해야 퇴거. 인수액을 입찰가에서 차감했는지 확인. 협상 레버리지 약함 — 보증금 반환 일정·방식 합의가 핵심.' },
  LIEN: { remedy: 'LAWSUIT', remedyLabel: '명도소송(유치권)', writEligible: false, difficulty: 'hard', costMult: 1.8, monthsLow: 8, monthsHigh: 18, reason: '유치권 주장 점유 → 성립 시 피담보채권 변제 전 인도 거부 가능. 인도명령 어렵고 소송·유치권부존재 다툼.', brief: '유치권 성립 여부(점유·견련성·공사대금 증빙) 검증 필수. 불성립 입증 시 인도명령, 성립 시 채권 변제 부담. 전문가 상담 강력 권장.' },
  UNKNOWN: { remedy: 'WRIT_THEN_LAWSUIT', remedyLabel: '확인 필요', writEligible: false, difficulty: 'medium', costMult: 1.2, monthsLow: 2, monthsHigh: 6, reason: '점유관계 미상 — 현황조사·전입세대열람으로 점유자 확정 후 재판단(보수적).', brief: '점유자 확정이 먼저. 전입세대열람·현장 점유 확인 후 인도명령/소송 판단.' },
};

/** 면적·점유유형 → 명도 비용 레인지(원). base 실비 = 평형 노무비+운반보관+집행관, 점유유형 배율. */
function evictionCost(areaM2: number, mult: number): { low: number; base: number; high: number } {
  const py = m2ToPyeong(areaM2 || 33);
  // 강제집행 실비 base(2026 보수적): 운반·보관 110만 + 집행관/실비 ~80만 + 노무비(인부수×15만)
  let labor: number;
  if (py < 10) labor = 3; else if (py < 20) labor = 5; else if (py < 30) labor = 8; else if (py < 40) labor = 11; else labor = 11 + Math.ceil((py - 40) / 10) * 3;
  const base = (1_100_000 + 800_000 + labor * 150_000) * mult;
  return { low: Math.round(base * 0.7), base: Math.round(base), high: Math.round(base * 1.4) };
}

export function analyzeEviction(rights: RightsAnalysisResult, areaM2: number | undefined, notes: string[]): EvictionAnalysis {
  const type = inferOccupantType(rights, notes);
  const p = PROFILES[type];
  const cost = evictionCost(areaM2 ?? 0, p.costMult);
  const laws = [{ name: MJ, article: '제136조(인도명령)' }];
  if (p.remedy !== 'WRIT') laws.push({ name: MJ, article: '제258조(부동산 인도 강제집행)' });
  const evNotes: string[] = ['명도 비용은 지역 집행관·인력단가로 ±30% 변동 — 입찰엔 high(보수적 상단) 사용 권장.'];
  if (type === 'TENANT_OPP_ASSUMED') evNotes.push('명도비와 별개로 인수 보증금(권리분석 인수금액)을 반환해야 함.');
  if (type === 'UNKNOWN') evNotes.push('점유 확정 전까지 난이도·비용은 잠정치.');
  return {
    occupantLabel: LABEL[type], remedy: p.remedy, remedyLabel: p.remedyLabel, writEligible: p.writEligible,
    difficulty: p.difficulty, costLow: cost.low, costBase: cost.base, costHigh: cost.high,
    monthsLow: p.monthsLow, monthsHigh: p.monthsHigh, reason: p.reason, negotiationBrief: p.brief, laws, notes: evNotes,
  };
}
