/**
 * 통화·금액·비율 포매터 + 금액 단위 상수 — 전 모듈 단일 정의.
 * (이전엔 won/eok/pct·EOK가 8+ 파일에 사본으로 흩어져 표기 정책 표류·누락 위험. ADR 리뷰 #1)
 */

/** 1억(원) */
export const EOK = 100_000_000;
/** 1만(원) */
export const MANWON = 10_000;

/** 금액(원) → "1,234,000원" */
export const won = (n: number): string => n.toLocaleString('ko-KR') + '원';

/** 금액(원) → "1.23억" (null/undefined → "-") */
export const eok = (n: number | null | undefined): string =>
  n == null ? '-' : (n / EOK).toFixed(2) + '억';

/** 비율(0~1) → "12.3%" (null/undefined → "-") */
export const pct = (n: number | null | undefined): string =>
  n == null ? '-' : (n * 100).toFixed(1) + '%';

/** 만원 → 원 */
export const manwonToWon = (manwon: number): number => manwon * MANWON;
