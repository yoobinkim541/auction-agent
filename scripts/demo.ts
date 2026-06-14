/**
 * 키/DB 없이 권리분석 엔진 + 점수화를 직접 시연한다(스모크 테스트).
 *   npx tsx scripts/demo.ts
 */
import { analyzeRights, kindLabel } from '../pipeline/rights/engine.ts';
import { scoreListing, maxSafeBid } from '../pipeline/select/score.ts';
import type { RightsInput, LocationAnalysis } from '../shared/types.ts';

const 억 = 100_000_000;
const 만 = 10_000;

const examples: { title: string; input: RightsInput; loc: LocationAnalysis }[] = [
  {
    title: '① 깨끗한 아파트 (인수 0, 임차인 없음)',
    input: {
      listing: { caseNo: '2024타경1001', court: '서울중앙지법', address: '서울특별시 송파구 잠실동 1', minBidPrice: 8 * 억, appraisalValue: 11 * 억, isCollectiveBuilding: true },
      registry: [
        { kind: 'geunjeodang', receiptDate: '2019-03-10', amount: 6 * 억 },
        { kind: 'gyeongmae_gaesi', receiptDate: '2024-02-01' },
      ],
      tenants: [],
    },
    loc: { caseNo: '2024타경1001', marketPrice: 12 * 억, comps: [], safetyMargin: (12 * 억 - 8 * 억) / (12 * 억) },
  },
  {
    title: '② 선순위 대항력 임차인 (배당요구 없음 → 보증금 전액 인수)',
    input: {
      listing: { caseNo: '2024타경1002', court: '수원지법', address: '경기도 수원시 영통구 2', minBidPrice: 4 * 억, appraisalValue: 5 * 억, isCollectiveBuilding: true },
      registry: [{ kind: 'geunjeodang', receiptDate: '2021-05-01', amount: 2 * 억 }],
      tenants: [{ deposit: 3 * 억, moveInDate: '2019-01-01', occupancyDate: '2019-01-01', demandedDistribution: false, occupied: true }],
    },
    loc: { caseNo: '2024타경1002', marketPrice: 5 * 억, comps: [], safetyMargin: (5 * 억 - 4 * 억) / (5 * 억) },
  },
  {
    title: '③ 유치권 신고 (검토 필요)',
    input: {
      listing: { caseNo: '2024타경1003', court: '인천지법', address: '인천광역시 연수구 3', minBidPrice: 3 * 억, appraisalValue: 5 * 억, isCollectiveBuilding: false },
      registry: [{ kind: 'geunjeodang', receiptDate: '2020-01-01', amount: 2 * 억 }],
      tenants: [],
      notes: ['유치권 신고 있음(공사대금 1.5억 주장)'],
    },
    loc: { caseNo: '2024타경1003', marketPrice: 5 * 억, comps: [], safetyMargin: 0.4 },
  },
];

for (const ex of examples) {
  const r = analyzeRights(ex.input);
  r.maxSafeBid = maxSafeBid(ex.loc.marketPrice, r.assumedAmount, 0.1);
  const s = scoreListing(r.caseNo, r, ex.loc, ex.input.listing.isCollectiveBuilding ? 'apartment' : 'villa', ex.input.listing.address);
  console.log('\n' + '─'.repeat(70));
  console.log(ex.title);
  console.log('─'.repeat(70));
  console.log(`말소기준권리 : ${r.malsoBasis.note}`);
  console.log(`위험등급     : ${r.riskGrade}  (clean=${r.isClean})`);
  console.log(`인수금액     : ${r.assumedAmount.toLocaleString('ko-KR')}원`);
  if (r.assumedBreakdown.length) r.assumedBreakdown.forEach((b) => console.log(`   - ${b.label}: ${b.amount.toLocaleString('ko-KR')}원 (${b.reason})`));
  console.log(`안전마진     : ${ex.loc.safetyMargin !== null ? (ex.loc.safetyMargin * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`최대안전입찰 : ${r.maxSafeBid?.toLocaleString('ko-KR')}원`);
  if (r.redFlags.length) console.log(`레드플래그   : ${r.redFlags.map((f) => f.message).join(' | ')}`);
  console.log(`점수/통과    : ${s.totalScore}점, ${s.passedFilter ? 'PASS ✅' : 'SKIP ❌ (' + s.reason + ')'}`);
  void kindLabel; void 만;
}
console.log('\n(참고용 정보이며 법률자문이 아닙니다.)');
