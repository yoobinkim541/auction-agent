import type { DecisionKind, DecisionReason, PrecisionObj, PrecisionStatus } from './api.ts';

const PRECISION_VIEWS: Record<PrecisionStatus, { label: string; summary: string; tone: string }> = {
  recommended: { label: '정밀 추천', summary: '권리·점유·시세 검증을 통과한 후보입니다.', tone: 'recommended' },
  conditional: { label: '조건부 검토', summary: '필수 확인을 마친 뒤에만 다음 판단으로 진행하세요.', tone: 'conditional' },
  hold: { label: '보류', summary: '시세 근거 부족 또는 필수 확인 미완료로 보류합니다.', tone: 'hold' },
  rejected: { label: '제외', summary: '현재 근거로는 입찰 검토 대상이 아닙니다.', tone: 'rejected' },
};

const DECISION_REASONS: Record<DecisionReason, string> = {
  price: '가격',
  rights: '권리관계',
  location: '입지',
  field: '현장 확인',
  capital: '자금',
  schedule: '일정',
  preference: '선호도',
  data_missing: '데이터 부족',
};

const DECISIONS: Record<DecisionKind, string> = {
  reviewing: '검토 시작',
  favorite: '관심',
  hold: '보류',
  fieldwork: '임장 진행',
  bid_review: '입찰 검토',
  rejected: '제외',
};

export function precisionView(precision: Pick<PrecisionObj, 'status' | 'reason_codes'>) {
  const view = PRECISION_VIEWS[precision.status];
  if (precision.status === 'hold' && precision.reason_codes.includes('MISSING_MARKET_PRICE')) {
    return { ...view, summary: '시세 근거 부족으로 보류합니다. 비교 가능한 거래를 보강하세요.' };
  }
  return view;
}

export function canShowBid(precision: Pick<PrecisionObj, 'status'>): boolean {
  return precision.status === 'recommended';
}

export function confidenceLabel(confidence: PrecisionObj['confidence']): string {
  return { high: '높음', medium: '보통', low: '낮음' }[confidence];
}

export function decisionReasonLabel(reason: DecisionReason | null | undefined): string {
  return reason ? DECISION_REASONS[reason] : '사유 없음';
}

export function decisionLabel(decision: DecisionKind): string {
  return DECISIONS[decision];
}

export const decisionReasons = Object.entries(DECISION_REASONS) as [DecisionReason, string][];
export const decisions = Object.entries(DECISIONS) as [DecisionKind, string][];
