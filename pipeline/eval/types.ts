/**
 * 모의경매 등 "정답이 있는" 사건을 활용한 평가/학습 타입.
 *
 * 용도:
 *  (A) 평가셋 — 정답(expected) ↔ 엔진 출력 대조로 정확도 측정·회귀 테스트.
 *  (B) 사례 라이브러리 — 해결된 사건을 Claude 검증의 few-shot/RAG로 재사용.
 */
import type { RightsInput } from '../../shared/types.ts';

/** 사건의 '정답' 라벨(모의경매 해설/사이트 권리분석에서 추출) */
export interface ExpectedAnswer {
  /** 말소기준권리 일자 (ISO) */
  malsoDate?: string;
  /** 총 인수금액 (원) */
  assumedAmount?: number;
  /** 권리관계 깨끗(인수 0) 여부 */
  isClean?: boolean;
  /** 임차인별 대항력 (input.tenants 순서와 일치) */
  tenantOpposition?: boolean[];
  /** 실제 낙찰가(있으면 — 입지/시세 모델 평가에 사용) */
  actualSalePrice?: number;
}

export interface SolvedCase {
  id: string;
  /** 출처: '모의경매' | 'site' | 'manual' */
  source: string;
  input: RightsInput;
  expected: ExpectedAnswer;
  note?: string;
}
