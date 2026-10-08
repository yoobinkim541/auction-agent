/**
 * EMPTY_REGISTRY(등기 미확보) 물건 전용 AI 1차 소견.
 *
 * 배경: 결정형 엔진의 registry는 courtauction API의 tprtyRnkHypthcStngDts(최선순위설정)
 * 단일 필드에서만 날짜를 추출한다. 이 필드가 비어있으면 엔진은 말소기준권리를 못 정하고
 * hold로 떨어진다(shared/data-trust.ts EMPTY_REGISTRY).
 *
 * 역할: 원문(명세서 비고 전체+감정평가서 텍스트)과 법령 RAG로 "1차 소견"만 낸다.
 * ⚠️ claude-verify.ts와 동일 원칙 — 새 법적 결론을 단정하지 않는다. 이 소견은
 * precision 평가에서 hold를 conditional로 완화만 할 수 있고 recommended 승격은
 * 영구히 불가(pipeline/precision/evaluate.ts registryGapCoverable 참고). 등기부
 * 직접 열람이 반드시 필요하다는 안내를 항상 동반한다.
 */
import { spawn } from 'node:child_process';
import type { LegalChunk } from '../rights/claude-verify.ts';

export const REGISTRY_OPINION_MODEL = 'claude-cli(subscription)';

export interface RegistryOpinionArgs {
  caseNo: string;
  propertyType: string;
  /** 명세서 비고 전체(대항력·인수권리·최선순위설정 등 자연어) */
  notes: string[];
  /** 감정평가서 원문(있으면) */
  appraisalText?: string;
  legalContext?: LegalChunk[];
}

export interface RegistryOpinion {
  hasClue: boolean;
  tentativeKind: string | null;
  tentativeDate: string | null;
  explanation: string;
  citations: { law: string; article: string; quote: string }[];
  requiredChecks: string[];
  confidence: 'high' | 'medium' | 'low';
}

const MANDATORY_CHECK = '등기부등본을 직접 열람해 말소기준권리(최선순위 설정)를 확인하세요 — 이 소견은 AI 1차 판단이며 미확정입니다.';

function buildPrompt(args: RegistryOpinionArgs): string {
  const legalBlock = (args.legalContext ?? [])
    .map((c, i) => `[${i + 1}] ${c.lawName} ${c.article}\n${c.content}`)
    .join('\n\n');
  return [
    '당신은 대한민국 부동산 경매 권리분석을 보조하는 분석가입니다.',
    '중요 원칙:',
    '1) 결정형 엔진이 이 물건의 말소기준권리(최선순위 설정)를 확정하지 못했습니다(원천 데이터 공백).',
    '   당신은 "확정 판정"을 내리는 게 아니라, 아래 원문에서 단서를 찾아 미확정 1차 소견만 제시합니다.',
    '2) 법령/판례 인용은 제공된 legalContext 안의 내용만 사용하십시오. 없으면 citations를 빈 배열로 두십시오.',
    '3) 이 소견은 참고용이며 법률자문이 아닙니다. 등기부 직접 열람 없이는 어떤 경우에도 확정으로 표현하지 마십시오.',
    '',
    `## 물건: ${args.caseNo} (${args.propertyType})`,
    '## 매각물건명세서 비고(원문)',
    args.notes.length ? args.notes.map((n, i) => `[${i + 1}] ${n}`).join('\n') : '(비고 없음)',
    args.appraisalText ? `\n## 감정평가서 원문(발췌)\n${args.appraisalText.slice(0, 6000)}` : '',
    legalBlock ? `\n## 참고 법령/판례(인용은 여기서만)\n${legalBlock}` : '\n## 참고 법령/판례: 없음(citations 빈 배열)',
    '',
    '아래 JSON **하나만** 출력하라(마크다운/설명 금지):',
    '{"hasClue":boolean,"tentativeKind":string|null,"tentativeDate":string|null,"explanation":string,' +
      '"citations":[{"law":string,"article":string,"quote":string}],"confidence":"high"|"medium"|"low"}',
    '',
    'hasClue=true는 "원문에 말소기준권리 관련 단서가 있어 잠정적으로 추정 가능"할 때만. ' +
      '단서가 전혀 없으면 hasClue=false, tentativeKind/tentativeDate=null.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function callClaudeCliOnce(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const cp = spawn('claude', ['-p', '--output-format', 'json', '--max-turns', '1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { cp.kill('SIGKILL'); reject(new Error('claude CLI 타임아웃')); }, 90_000);
    cp.stdout.on('data', (d) => (stdout += d));
    cp.stderr.on('data', (d) => (stderr += d));
    cp.on('error', reject);
    cp.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stderr.trim() && !stdout.trim()) return reject(new Error('RATE_LIMIT'));
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${stderr.slice(0, 200)}`));
      resolve(stdout);
    });
    cp.stdin.write(prompt);
    cp.stdin.end();
  });
}

/**
 * claude 응답 원문(코드펜스/잡텍스트 섞여 있을 수 있음) → RegistryOpinion 정규화.
 * 안전장치: requiredChecks는 모델 출력과 무관하게 항상 MANDATORY_CHECK 하나만 강제 포함한다
 * (모델이 이 문구를 빠뜨리거나 다른 문구를 지어내도, "등기부 직접 열람 필요" 안내는 반드시 붙는다).
 */
export function parseRegistryOpinion(raw: string): RegistryOpinion {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const s = text.indexOf('{'); const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) text = text.slice(s, e + 1);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const confidence = parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
    ? parsed.confidence : 'low';
  const citations = Array.isArray(parsed.citations)
    ? (parsed.citations as unknown[])
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({ law: str(c.law), article: str(c.article), quote: str(c.quote) }))
    : [];
  const hasClue = parsed.hasClue === true;
  return {
    hasClue,
    tentativeKind: hasClue && typeof parsed.tentativeKind === 'string' ? parsed.tentativeKind : null,
    tentativeDate: hasClue && typeof parsed.tentativeDate === 'string' ? parsed.tentativeDate : null,
    explanation: str(parsed.explanation).slice(0, 800),
    citations,
    requiredChecks: [MANDATORY_CHECK],
    confidence,
  };
}

export async function getRegistryOpinion(args: RegistryOpinionArgs): Promise<RegistryOpinion> {
  const prompt = buildPrompt(args);
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 15_000 * attempt));
    try {
      const out = await callClaudeCliOnce(prompt);
      const envelope = JSON.parse(out) as { result?: string; is_error?: boolean };
      if (envelope.is_error) throw new Error('claude envelope is_error=true');
      return parseRegistryOpinion(envelope.result ?? out);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (!lastErr.message.includes('RATE_LIMIT')) break;
    }
  }
  throw lastErr ?? new Error('claude CLI 실패');
}
