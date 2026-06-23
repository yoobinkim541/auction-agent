/**
 * 면적 단위 변환 — ㎡↔평 단일 상수. (이전엔 3.305785 vs 3.3058 로 모듈 간 표류. ADR 리뷰 #2)
 */

/** 1평 = 3.305785㎡ */
export const SQM_PER_PYEONG = 3.305785;

/** ㎡ → 평 */
export const m2ToPyeong = (m2: number): number => m2 / SQM_PER_PYEONG;

/** 평 → ㎡ */
export const pyeongToM2 = (pyeong: number): number => pyeong * SQM_PER_PYEONG;
