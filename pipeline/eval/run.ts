/**
 * 평가 실행기: gm_solved_cases(모의경매 정답)를 불러와 엔진 정확도를 채점한다.
 *   npm run eval
 */
import 'dotenv/config';
import { fetchSolvedCases } from '../../shared/db.ts';
import { runEval, printReport } from './harness.ts';
import type { SolvedCase } from './types.ts';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL이 없어 DB 평가를 건너뜁니다. (.env 설정 후 재실행)');
    return;
  }
  const data = await fetchSolvedCases(1000);
  const cases: SolvedCase[] = data.map((r) => ({
    id: `${r.source}:${r.case_no ?? '?'}`,
    source: r.source,
    input: r.input_json,
    expected: r.expected_json,
    note: r.note ?? undefined,
  }));
  if (cases.length === 0) {
    console.log('gm_solved_cases가 비어 있습니다. 모의경매 정답 사건을 먼저 적재하세요.');
    return;
  }
  printReport(runEval(cases));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
