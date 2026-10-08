/**
 * Phase3 LLM 복기 — 서프라이즈 케이스마다 claude CLI로 "왜 이 결과?" 추론.
 * 구조화 출력: { tags: string[], reason: string }.
 * gm_postmortems에 저장(이미 처리된 케이스는 건너뜀).
 * 사용: npm run eval:postmortem [--top N] [--type overpriced|avoid_but_sold|passed_but_unsold]
 * 환경변수: POSTMORTEM_LIMIT (기본 10), POSTMORTEM_DELAY_MS (기본 3000)
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { query, pool } from '../shared/db.ts';

interface SurpriseRow {
  case_no: string; item_no: string; sale_date: string;
  property_type: string; address: string; region: string;
  appraisal_value: number; expected_bid: number | null; sold_amount: number | null;
  sale_ratio: number | null; residual_pct: number | null;
  total_score: number | null; recommendation: string | null;
  inq_cnt: number | null; interest_cnt: number | null;
  market_price: number | null; min_bid_price: number | null;
  surprise_type: string;
}

interface PostmortemResult { tags: string[]; reason: string; }

const VALID_TAGS = [
  '재건축', '재개발', '학군', '역세권', '신축', '대단지', '브랜드아파트',
  '전세가율', '실거주수요', '급매경쟁', '특수권리감수', '소액투자',
  '상권', '공원조망', '교통요충', '저층기피', '경쟁과열', '시세대비저가',
  '회차진행', '빌라선호', '오피스텔특성', '입지프리미엄', '감정가낮음', '기타',
];

function eok(n: number | null | undefined): string {
  return n == null ? '-' : `${(n / 1e8).toFixed(2)}억`;
}

function buildPrompt(row: SurpriseRow, surpriseType: string): string {
  const saleRatioPct = row.sale_ratio != null ? `${(row.sale_ratio * 100).toFixed(0)}%` : '-';
  const residualPct = row.residual_pct != null ? `${(row.residual_pct >= 0 ? '+' : '')}${(row.residual_pct * 100).toFixed(0)}%` : '-';
  const typeDesc = surpriseType === 'overpriced'
    ? `예상(${eok(row.expected_bid)})보다 실제 낙찰가(${eok(row.sold_amount)})가 훨씬 높음(${residualPct})`
    : surpriseType === 'avoid_but_sold'
      ? `우리가 낮은 점수(${row.total_score}점)·${row.recommendation ?? '비추'}으로 봤으나 낙찰가율 ${saleRatioPct}에 낙찰`
      : `우리가 추천(점수 ${row.total_score}점)했으나 유찰`;

  return `당신은 한국 부동산 경매 결과 복기를 돕는 분석 보조입니다.
아래 경매 물건의 결과를 보고, 우리 예측과 실제 결과 차이의 원인을 분석하세요.

## 물건 정보
- 사건번호: ${row.case_no} (${row.property_type})
- 주소: ${row.address}
- 매각기일: ${row.sale_date}
- 감정가: ${eok(row.appraisal_value)} | 최저매각가: ${eok(row.min_bid_price)}
- 우리 예상낙찰가: ${eok(row.expected_bid)} | 실제낙찰가: ${eok(row.sold_amount)}
- 낙찰가율: ${saleRatioPct} | 예측오차: ${residualPct}
- 우리 시세추정: ${eok(row.market_price)}
- 시스템 점수: ${row.total_score ?? '-'} | 추천: ${row.recommendation ?? '-'}
- 조회수: ${row.inq_cnt ?? '-'} | 관심수: ${row.interest_cnt ?? '-'}

## 서프라이즈 유형
${typeDesc}

## 분석 지침
이 결과 차이의 원인을 한국 부동산 경매 맥락에서 추론하세요.
가능한 원인 후보(복수 해당 가능):
${VALID_TAGS.join(', ')}

아래 JSON **하나만** 출력하라(마크다운/설명 금지):
{"tags":["태그1","태그2"],"reason":"1~2문장 근거"}

tags는 위 후보에서만 선택(최대 4개), reason은 한국어 1~2문장.`;
}

async function callClaudeCliOnce(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const cp = spawn('claude', ['-p', '--output-format', 'json', '--max-turns', '1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { cp.kill('SIGKILL'); reject(new Error('claude CLI 타임아웃')); }, 90_000);
    cp.stdout.on('data', (d) => (stdout += d));
    cp.stderr.on('data', (d) => (stderr += d));
    cp.on('error', reject);
    cp.on('close', (code) => {
      clearTimeout(timer);
      // exit 1 + 빈 stderr = 버스트 레이트리밋 신호
      if (code !== 0 && !stderr.trim() && !stdout.trim()) {
        return reject(new Error('RATE_LIMIT'));
      }
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${stderr.slice(0, 200)}`));
      resolve(stdout);
    });
    cp.stdin.write(prompt);
    cp.stdin.end();
  });
}

async function callClaudeCli(prompt: string): Promise<PostmortemResult> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const backoff = 15_000 * attempt;
      console.log(`  → 재시도 ${attempt}/2 (${backoff / 1000}s 대기)`);
      await new Promise((r) => setTimeout(r, backoff));
    }
    try {
      const out = await callClaudeCliOnce(prompt);
      const envelope = JSON.parse(out) as { result?: string; is_error?: boolean };
      if (envelope.is_error) throw new Error('claude envelope is_error=true');
      let text = (envelope.result ?? out).trim();
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const s = text.indexOf('{'); const e = text.lastIndexOf('}');
      if (s >= 0 && e > s) text = text.slice(s, e + 1);
      const parsed = JSON.parse(text) as { tags?: unknown; reason?: unknown };
      return {
        tags: Array.isArray(parsed.tags) ? (parsed.tags as string[]).filter((t) => VALID_TAGS.includes(t)).slice(0, 4) : [],
        reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 400) : '',
      };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (!lastErr.message.includes('RATE_LIMIT')) break;
    }
  }
  throw lastErr ?? new Error('claude CLI 실패');
}

async function getSurprises(limit: number, typeFilter: string | null): Promise<SurpriseRow[]> {
  const rows: SurpriseRow[] = [];

  // overpriced: residual_pct 상위 (sold >> expected)
  if (!typeFilter || typeFilter === 'overpriced') {
    const r = await query<SurpriseRow>(`
      SELECT e.case_no, e.item_no, e.sale_date::text, e.property_type, l.address,
             split_part(l.address, ' ', 1) || ' ' || split_part(l.address, ' ', 2) as region,
             e.appraisal_value::float8, e.expected_bid::float8, e.sold_amount::float8,
             e.sale_ratio, e.residual_pct, e.total_score, e.recommendation,
             e.inq_cnt, e.interest_cnt, e.market_price::float8, e.min_bid_price::float8,
             'overpriced' as surprise_type
        FROM gm_trusted_outcome_eval e
        JOIN gm_listings l ON l.case_no = e.case_no AND coalesce(l.item_no,'1') = e.item_no
       WHERE e.sale_date < current_date AND e.residual_pct IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM gm_postmortems p
                          WHERE p.case_no = e.case_no AND p.item_no = e.item_no
                            AND p.sale_date = e.sale_date AND p.surprise_type = 'overpriced')
       ORDER BY e.residual_pct DESC LIMIT ${limit}`);
    rows.push(...r);
  }

  // avoid_but_sold: 미통과/회피인데 낙찰가율 높은 순
  if (!typeFilter || typeFilter === 'avoid_but_sold') {
    const r = await query<SurpriseRow>(`
      SELECT e.case_no, e.item_no, e.sale_date::text, e.property_type, l.address,
             split_part(l.address, ' ', 1) || ' ' || split_part(l.address, ' ', 2) as region,
             e.appraisal_value::float8, e.expected_bid::float8, e.sold_amount::float8,
             e.sale_ratio, e.residual_pct, e.total_score, e.recommendation,
             e.inq_cnt, e.interest_cnt, e.market_price::float8, e.min_bid_price::float8,
             'avoid_but_sold' as surprise_type
        FROM gm_trusted_outcome_eval e
        JOIN gm_listings l ON l.case_no = e.case_no AND coalesce(l.item_no,'1') = e.item_no
       WHERE e.sale_date < current_date AND e.sold = true
         AND (e.passed_filter = false OR e.recommendation = 'avoid')
         AND e.sale_ratio > 1.0
         AND NOT EXISTS (SELECT 1 FROM gm_postmortems p
                          WHERE p.case_no = e.case_no AND p.item_no = e.item_no
                            AND p.sale_date = e.sale_date AND p.surprise_type = 'avoid_but_sold')
       ORDER BY e.sale_ratio DESC LIMIT ${limit}`);
    rows.push(...r);
  }

  // passed_but_unsold: 추천했는데 유찰
  if (!typeFilter || typeFilter === 'passed_but_unsold') {
    const r = await query<SurpriseRow>(`
      SELECT e.case_no, e.item_no, e.sale_date::text, e.property_type, l.address,
             split_part(l.address, ' ', 1) || ' ' || split_part(l.address, ' ', 2) as region,
             e.appraisal_value::float8, e.expected_bid::float8, e.sold_amount::float8,
             e.sale_ratio, e.residual_pct, e.total_score, e.recommendation,
             e.inq_cnt, e.interest_cnt, e.market_price::float8, e.min_bid_price::float8,
             'passed_but_unsold' as surprise_type
        FROM gm_outcome_eval e
        JOIN gm_listings l ON l.case_no = e.case_no AND coalesce(l.item_no,'1') = e.item_no
       WHERE e.sale_date < current_date AND e.matched = true AND e.sold = false
         AND e.passed_filter = true
         AND NOT EXISTS (SELECT 1 FROM gm_postmortems p
                          WHERE p.case_no = e.case_no AND p.item_no = e.item_no
                            AND p.sale_date = e.sale_date AND p.surprise_type = 'passed_but_unsold')
       ORDER BY e.total_score DESC NULLS LAST LIMIT ${limit}`);
    rows.push(...r);
  }

  return rows;
}

async function printTagSummary(): Promise<void> {
  const rows = await query<{ tag: string; n: number }>(`
    SELECT t.value as tag, count(*)::int as n
      FROM gm_postmortems, jsonb_array_elements_text(tags) t(value)
     GROUP BY t.value
     ORDER BY n DESC`);
  if (!rows.length) return;
  console.log('\n=== 태그 집계 ===');
  for (const r of rows) console.log(`  ${r.tag}: ${r.n}건`);
}

async function main(): Promise<void> {
  const limit = Number(process.env.POSTMORTEM_LIMIT) || 10;
  const delayMs = Number(process.env.POSTMORTEM_DELAY_MS) || 3000;
  const typeArg = process.argv.find((a) => a.startsWith('--type='))?.split('=')[1] ?? null;
  const topArg = Number(process.argv.find((a) => a.startsWith('--top='))?.split('=')[1] ?? 0) || limit;

  const rows = await getSurprises(topArg, typeArg);
  if (!rows.length) {
    console.log('처리할 신규 서프라이즈 케이스가 없습니다.');
    await pool().end();
    return;
  }

  console.log(`Phase3 복기 시작: ${rows.length}건 (delay ${delayMs}ms)`);
  let done = 0; let failed = 0;

  for (const row of rows) {
    const label = `${row.case_no} (${row.surprise_type})`;
    try {
      const prompt = buildPrompt(row, row.surprise_type);
      const result = await callClaudeCli(prompt);
      await query(`
        INSERT INTO gm_postmortems
          (case_no, item_no, sale_date, surprise_type,
           property_type, address, region,
           appraisal_value, expected_bid, sold_amount, sale_ratio, residual_pct,
           total_score, recommendation, inq_cnt, interest_cnt, tags, reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (case_no, item_no, sale_date, surprise_type) DO NOTHING`,
        [row.case_no, row.item_no, row.sale_date, row.surprise_type,
         row.property_type, row.address, row.region,
         row.appraisal_value, row.expected_bid, row.sold_amount, row.sale_ratio, row.residual_pct,
         row.total_score, row.recommendation, row.inq_cnt, row.interest_cnt,
         JSON.stringify(result.tags), result.reason],
      );
      console.log(`✅ ${label} → [${result.tags.join(', ')}] ${result.reason.slice(0, 60)}...`);
      done++;
    } catch (e) {
      console.error(`❌ ${label}: ${e instanceof Error ? e.message : e}`);
      failed++;
    }
    if (done + failed < rows.length) await new Promise((r) => setTimeout(r, delayMs));
  }

  console.log(`\n완료: ${done}건 저장, ${failed}건 실패`);
  await printTagSummary();
  await pool().end();
}

main().catch((e) => { console.error('eval-postmortem 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
