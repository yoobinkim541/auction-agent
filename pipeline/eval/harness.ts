/**
 * 평가 채점기: 엔진 출력 ↔ 정답(ExpectedAnswer) 대조.
 * 모의경매 사건 수백 건을 돌려 정확도를 측정하고, 틀린 사건을 회귀 케이스로 뽑아낸다.
 */
import { analyzeRights } from '../rights/engine.ts';
import type { SolvedCase, ExpectedAnswer } from './types.ts';

export interface FieldResult {
  field: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
}
export interface CaseResult {
  id: string;
  fields: FieldResult[];
  pass: boolean;
}
export interface EvalReport {
  total: number;
  passedCases: number;
  caseAccuracy: number; // 0~1 (모든 채점 필드 통과한 사건 비율)
  fieldAccuracy: Record<string, { ok: number; n: number; rate: number }>;
  failures: CaseResult[];
}

/** 금액은 정확히 일치 요구(원 단위 라벨 가정). 필요 시 tolerance 추가 가능. */
function eqAmount(a: number | undefined, b: number): boolean {
  return a === undefined || a === b;
}

export function evaluateCase(c: SolvedCase): CaseResult {
  const r = analyzeRights(c.input);
  const e: ExpectedAnswer = c.expected;
  const fields: FieldResult[] = [];

  if (e.malsoDate !== undefined) {
    fields.push({ field: 'malsoDate', expected: e.malsoDate, actual: r.malsoBasis.date, ok: r.malsoBasis.date === e.malsoDate });
  }
  if (e.assumedAmount !== undefined) {
    fields.push({ field: 'assumedAmount', expected: e.assumedAmount, actual: r.assumedAmount, ok: eqAmount(e.assumedAmount, r.assumedAmount) });
  }
  if (e.isClean !== undefined) {
    fields.push({ field: 'isClean', expected: e.isClean, actual: r.isClean, ok: r.isClean === e.isClean });
  }
  if (e.tenantOpposition !== undefined) {
    e.tenantOpposition.forEach((exp, i) => {
      const actual = r.tenants[i]?.hasOpposition ?? null;
      fields.push({ field: `tenant[${i}].hasOpposition`, expected: exp, actual, ok: actual === exp });
    });
  }

  return { id: c.id, fields, pass: fields.every((f) => f.ok) };
}

export function runEval(cases: SolvedCase[]): EvalReport {
  const results = cases.map(evaluateCase);
  const fieldAccuracy: EvalReport['fieldAccuracy'] = {};
  for (const res of results) {
    for (const f of res.fields) {
      const key = f.field.replace(/\[\d+\]/, '[]'); // tenant[0]→tenant[]
      const acc = (fieldAccuracy[key] ??= { ok: 0, n: 0, rate: 0 });
      acc.n++;
      if (f.ok) acc.ok++;
    }
  }
  for (const k of Object.keys(fieldAccuracy)) {
    const a = fieldAccuracy[k]!;
    a.rate = a.n ? a.ok / a.n : 0;
  }
  const passedCases = results.filter((r) => r.pass).length;
  return {
    total: cases.length,
    passedCases,
    caseAccuracy: cases.length ? passedCases / cases.length : 0,
    fieldAccuracy,
    failures: results.filter((r) => !r.pass),
  };
}

/** 해결 사건 → Claude few-shot/RAG용 텍스트 예시 */
export function caseToExample(c: SolvedCase): string {
  return [
    `사건 ${c.id} (${c.source})`,
    `소재지: ${c.input.listing.address} / 최저가: ${c.input.listing.minBidPrice.toLocaleString('ko-KR')}원`,
    `등기: ${c.input.registry.map((e) => `${e.kind}(${e.receiptDate})`).join(', ')}`,
    `임차인: ${c.input.tenants.map((t) => `보증금 ${t.deposit.toLocaleString('ko-KR')} 전입 ${t.moveInDate ?? '?'}`).join(' | ') || '없음'}`,
    `정답: 말소기준 ${c.expected.malsoDate ?? '?'}, 인수금액 ${c.expected.assumedAmount?.toLocaleString('ko-KR') ?? '?'}원, 깨끗=${c.expected.isClean ?? '?'}`,
    c.note ? `해설: ${c.note}` : '',
  ].filter(Boolean).join('\n');
}

/** 콘솔 리포트 출력 */
export function printReport(rep: EvalReport): void {
  console.log(`\n=== 평가 결과: 사건 ${rep.passedCases}/${rep.total} 통과 (${(rep.caseAccuracy * 100).toFixed(1)}%) ===`);
  for (const [k, a] of Object.entries(rep.fieldAccuracy)) {
    console.log(`  ${k}: ${a.ok}/${a.n} (${(a.rate * 100).toFixed(1)}%)`);
  }
  if (rep.failures.length) {
    console.log(`\n--- 실패 사건 ${rep.failures.length}건 (회귀 테스트 후보) ---`);
    for (const f of rep.failures) {
      const bad = f.fields.filter((x) => !x.ok).map((x) => `${x.field}: 정답 ${x.expected} ≠ 엔진 ${x.actual}`);
      console.log(`  ${f.id}: ${bad.join(' | ')}`);
    }
  }
}
