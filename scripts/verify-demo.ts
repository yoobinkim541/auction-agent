/** Claude Max 구독(claude CLI) 경유 권리분석 검증 1건 시연 + 법제처 법령 인용. */
import 'dotenv/config';
import { analyzeRights } from '../pipeline/rights/engine.ts';
import { searchLegal } from '../pipeline/legal/search.ts';
import { verifyRightsCli } from '../pipeline/rights/claude-verify-cli.ts';
import type { RightsInput } from '../shared/types.ts';

const 억 = 100_000_000;
const input: RightsInput = {
  listing: { caseNo: '2024-시연', court: '수원지법', address: '경기도 수원시 영통구', minBidPrice: 4 * 억, appraisalValue: 5 * 억, isCollectiveBuilding: true },
  registry: [{ kind: 'geunjeodang', receiptDate: '2021-05-01', amount: 2 * 억 }],
  tenants: [{ deposit: 3 * 억, moveInDate: '2019-01-01', occupancyDate: '2019-01-01', demandedDistribution: false, occupied: true }],
};

const rights = analyzeRights(input);
console.log('엔진:', rights.riskGrade, '인수금액', rights.assumedAmount.toLocaleString('ko-KR'));
const legalContext = await searchLegal('대항력 우선변제 임차인 인수 말소기준권리');
console.log('법령 컨텍스트:', legalContext.map((c) => `${c.lawName} ${c.article}`).join(', ') || '없음');
console.log('Claude(구독) 검증 중...');
const v = await verifyRightsCli({ engineResult: rights, legalContext });
console.log('\n=== 검증 결과 ===');
console.log('동의:', v.agrees);
console.log('설명:', v.explanation);
console.log('위험요약:', v.riskSummary);
console.log('인용:', v.citations.map((c) => `${c.law} ${c.article}`).join(' / ') || '없음');
console.log('권장확인:', v.recommendedChecks.join(' · '));
