/**
 * LLM 투자 의견서 — 통과 상위 후보만 Claude **구독 CLI**로 1건씩 생성(종량제 API 회피).
 * 권리·입지·수익·리스크를 종합한 3~5문장 의견서 + 입찰가/임장 관점. analyze 본 루프 종료 후 2차 패스로 실행.
 * 입력 핵심수치 해시(memoHash)가 그대로면 재생성 생략(비용·시간 절감). 결과는 gm_location_analysis.report.memo에 머지
 * → SELECT_BODY의 to_jsonb(loc)로 자동 노출(Java 무수정).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { query } from '../../shared/db.ts';
import { eok } from '../../shared/format.ts';
import type { ListingReport } from '../../shared/types.ts';

export const MEMO_MODEL = 'claude-cli(subscription)';

export interface MemoCandidate {
  id: number; caseNo: string; address: string; propertyType: string;
  appraisal: number | null; minBid: number | null; safetyMargin: number | null; totalScore: number | null;
  inq: number | null; interest: number | null; report: ListingReport;
}

/** 재생성 판단용 해시 — 의견서에 영향 주는 핵심 수치/결론이 바뀌면 값이 달라진다(순수). */
export function memoHash(c: MemoCandidate): string {
  const r = c.report ?? ({} as ListingReport);
  const key = JSON.stringify([
    c.caseNo, c.minBid, c.appraisal, c.safetyMargin, c.totalScore,
    r.recommendation, r.dangerCount, r.warnCount, r.headline, c.inq, c.interest,
  ]);
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/** 의견서 생성 프롬프트(순수) — 저장된 리포트 요약 + 매물 지표를 종합 입력으로. */
export function buildMemoPrompt(c: MemoCandidate): string {
  const r = c.report ?? ({} as ListingReport);
  const comp = c.inq != null || c.interest != null ? `조회 ${c.inq ?? '?'}·관심 ${c.interest ?? 0}` : '경쟁 데이터 없음';
  return [
    '당신은 대한민국 부동산 경매 투자 분석가입니다. 아래 한 매물의 자동 분석 결과를 종합해 간결한 "투자 의견서"를 작성하세요.',
    '',
    '[형식] 한국어, 3~5문장, 머리말·마크다운·불릿 없이 본문만. 단정적 법률자문은 피하고(참고용), 유치권 등 등기부 외 권리는 현장/전문가 확인으로 안내.',
    '[반드시 포함] (1)권리 안전성 (2)입지·시세 평가 (3)수익성(진짜 안전마진 기준) (4)핵심 리스크 1~2개 (5)보수적 권장 입찰 관점 (6)임장 시 확인 1~2개.',
    '',
    `[매물] 사건 ${c.caseNo} · ${c.propertyType} · ${c.address}`,
    `[지표] 감정 ${eok(c.appraisal)} / 최저 ${eok(c.minBid)} / 점수 ${c.totalScore ?? '-'} / 경쟁 ${comp}`,
    `[자동 결론] ${r.recommendation ?? '-'} — ${r.headline ?? ''}`,
    `[권리] ${r.rightsSummary ?? ''}`,
    `[입지] ${r.locationSummary ?? ''}`,
    `[비용] ${r.costSummary ?? ''}`,
    r.summary?.length ? `[요약] ${r.summary.join(' / ')}` : '',
  ].filter(Boolean).join('\n');
}

/** claude 구독 CLI 1회 호출 → 모델 최종 텍스트. (claude-verify-cli.ts와 동일 패턴) */
async function runClaude(prompt: string, timeoutMs = 120_000): Promise<string> {
  const out = await new Promise<string>((resolve, reject) => {
    const cp = spawn('claude', ['-p', '--output-format', 'json', '--max-turns', '1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { cp.kill('SIGKILL'); reject(new Error('claude CLI 타임아웃')); }, timeoutMs);
    cp.stdout.on('data', (d) => (stdout += d));
    cp.stderr.on('data', (d) => (stderr += d));
    cp.on('error', reject);
    cp.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude CLI exit ${code}: ${(stderr || stdout).slice(0, 200) || '(빈 stderr — 레이트리밋 추정)'}`));
      resolve(stdout);
    });
    cp.stdin.write(prompt);
    cp.stdin.end();
  });
  const envelope = JSON.parse(out) as { result?: string; is_error?: boolean; subtype?: string; api_error_status?: unknown };
  if (envelope.is_error || envelope.api_error_status || (envelope.subtype && envelope.subtype !== 'success')) {
    throw new Error(`claude 응답 오류: ${envelope.subtype ?? ''} ${JSON.stringify(envelope.api_error_status ?? '')}`.trim());
  }
  return (envelope.result ?? out).trim();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function generateMemo(c: MemoCandidate): Promise<string> {
  return runClaude(buildMemoPrompt(c));
}

/** claude CLI 사용 가능 여부(--version). */
export async function claudeCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const cp = spawn('claude', ['--version'], { stdio: 'ignore' });
    cp.on('error', () => resolve(false));
    cp.on('close', (code) => resolve(code === 0));
  });
}

/** 통과 + 점수 상위 N건에 의견서 생성(미래 매각기일만). 해시 동일하면 캐시 재사용. */
export async function generateMemosForTopCandidates(n: number): Promise<{ candidates: number; generated: number; cached: number; failed: number }> {
  const rows = await query<{
    id: number; case_no: string; address: string; property_type: string;
    av: number | null; mb: number | null; sm: number | null; ts: number | null;
    inq_cnt: number | null; interest_cnt: number | null; report: ListingReport | null;
  }>(
    `select l.id, l.case_no, l.address, l.property_type,
            l.appraisal_value::float8 av, l.min_bid_price::float8 mb,
            l.inq_cnt, l.interest_cnt, loc.safety_margin::float8 sm, s.total_score::int ts, loc.report
       from gm_scores s
       join gm_listings l on l.id = s.listing_id
       join gm_location_analysis loc on loc.listing_id = l.id
      where s.passed_filter = true and (l.sale_date is null or l.sale_date >= current_date)
      order by s.total_score desc nulls last
      limit $1`,
    [n],
  );

  let generated = 0, cached = 0, failed = 0;
  for (const row of rows) {
    if (!row.report || row.report.headline?.startsWith('[데이터 불완전]')) continue;
    const c: MemoCandidate = {
      id: row.id, caseNo: row.case_no, address: row.address, propertyType: row.property_type,
      appraisal: row.av, minBid: row.mb, safetyMargin: row.sm, totalScore: row.ts,
      inq: row.inq_cnt, interest: row.interest_cnt, report: row.report,
    };
    const h = memoHash(c);
    if (row.report.memo && row.report.memoHash === h) { cached++; continue; }

    // 구독 CLI 버스트 레이트리밋 대비: 실패 시 백오프 재시도(최대 3회), 성공 후 호출 간 간격.
    let memo: string | null = null;
    for (let attempt = 1; attempt <= 3 && memo == null; attempt++) {
      try {
        const out = await generateMemo(c);
        if (out) memo = out;
        else if (attempt === 3) failed++;
      } catch (e) {
        if (attempt === 3) { failed++; console.error(`의견서 실패 ${row.case_no}: ${e instanceof Error ? e.message : e}`); }
        else await sleep(5000 * attempt); // 5s, 10s 백오프
      }
    }
    if (memo) {
      await query('update gm_location_analysis set report = report || $2::jsonb where listing_id = $1', [
        row.id, JSON.stringify({ memo, memoModel: MEMO_MODEL, memoHash: h }),
      ]);
      generated++;
      await sleep(Number(process.env.MEMO_THROTTLE_MS) || 1500); // 호출 간 간격(버스트 한도 회피)
    }
  }
  return { candidates: rows.length, generated, cached, failed };
}
