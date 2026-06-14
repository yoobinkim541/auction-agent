/**
 * 더낙찰옥션 '모의경매' 어댑터 — 정답(해설) 있는 사건을 SolvedCase로 수집한다.
 *
 * 용도: 엔진 평가셋 + 해결사례 RAG(`pipeline/eval`). 본인 구독 계정 로그인 필요(개인 이용).
 *
 * ⚠️ 미완성(스켈레톤). 모의경매 메뉴 URL과 사건/해설 DOM 구조는 로그인 후 확인 필요:
 *   1) 로그인(메인 어댑터 ensureLogin 재사용) → 모의경매 목록 페이지
 *   2) 각 사건: 등기/임차인/명세서 입력 + '정답 해설'(말소기준·인수금액·대항력) 파싱
 *   3) normalize → SolvedCase{ input: RightsInput, expected: ExpectedAnswer }
 *   → gm_solved_cases upsert (pipeline/eval/run.ts가 채점)
 */
import type { SolvedCase } from '../../pipeline/eval/types.ts';
import type { CrawlFilter } from './types.ts';

export async function crawlMockAuctions(_filter: CrawlFilter): Promise<SolvedCase[]> {
  console.warn(
    '[mock] 모의경매 어댑터 미구현 — 로그인 후 모의경매 메뉴 URL/DOM 확인하여 채우세요. ' +
      'deonakchal.ts의 ensureLogin/newPage 재사용 권장.',
  );
  return [];
}
