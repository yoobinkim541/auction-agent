/**
 * Claude(Opus 4.8) 권리분석 2차 검증·설명.
 *
 * 역할: 결정형 rule engine 결과를 (1) 사이트가 제공한 권리분석, (2) 원문 문서와 대조하여
 * 불일치/누락/위험을 짚고, 일반인이 이해할 설명을 만든다. 법령/판례 인용은 RAG로 주입된
 * legalContext 안에서만 하도록 강제(할루시네이션 방지).
 *
 * ⚠️ 우선순위/인수·소멸 '판정'은 engine이 한다. Claude는 검토·설명·인용만.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { RightsAnalysisResult } from '../../shared/types.ts';

export const VERIFY_MODEL = 'claude-opus-4-8';

export interface LegalChunk {
  lawName: string;
  article: string;
  content: string;
}

export interface VerifyArgs {
  engineResult: RightsAnalysisResult;
  /** 사이트(더낙찰옥션)가 제공한 권리분석 요약(있으면 대조) */
  siteRights?: unknown;
  /** 매각물건명세서/현황조사서/등기요약 원문 텍스트(있으면) */
  sourceText?: string;
  /** RAG로 검색한 관련 법령/판례 — 인용은 이 안에서만 */
  legalContext?: LegalChunk[];
}

export interface VerifyOutput {
  agrees: boolean;
  discrepancies: { field: string; engineSays: string; concern: string }[];
  explanation: string; // 일반인용 권리분석 설명(한국어)
  riskSummary: string;
  citations: { law: string; article: string; quote: string }[];
  recommendedChecks: string[];
}

/** 외부(LLM API/CLI) 산출 객체를 VerifyOutput 형상으로 안전 정규화 — 필수 필드 누락/타입오류 시
 *  하류 undefined 접근·잘못된 값 저장을 막는다(검증은 보조 기능이라 throw 대신 보정). API·CLI 두 경로 공유. */
export function parseVerifyOutput(raw: unknown): VerifyOutput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const arr = <T>(v: unknown, map: (x: Record<string, unknown>) => T): T[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map(map) : [];
  return {
    agrees: o.agrees === true,
    discrepancies: arr(o.discrepancies, (d) => ({ field: str(d.field), engineSays: str(d.engineSays), concern: str(d.concern) })),
    explanation: str(o.explanation),
    riskSummary: str(o.riskSummary),
    citations: arr(o.citations, (c) => ({ law: str(c.law), article: str(c.article), quote: str(c.quote) })),
    recommendedChecks: Array.isArray(o.recommendedChecks) ? o.recommendedChecks.map(str).filter(Boolean) : [],
  };
}

const OUTPUT_TOOL: Anthropic.Tool = {
  name: 'submit_verification',
  description: '권리분석 검증 결과를 제출한다.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['agrees', 'discrepancies', 'explanation', 'riskSummary', 'citations', 'recommendedChecks'],
    properties: {
      agrees: { type: 'boolean', description: 'engine 결론에 동의하는지' },
      discrepancies: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'engineSays', 'concern'],
          properties: {
            field: { type: 'string' },
            engineSays: { type: 'string' },
            concern: { type: 'string' },
          },
        },
      },
      explanation: { type: 'string', description: '일반 투자자가 이해할 한국어 권리분석 설명' },
      riskSummary: { type: 'string' },
      citations: {
        type: 'array',
        description: 'legalContext에 포함된 조문/판례만 인용. 없으면 빈 배열.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['law', 'article', 'quote'],
          properties: { law: { type: 'string' }, article: { type: 'string' }, quote: { type: 'string' } },
        },
      },
      recommendedChecks: { type: 'array', items: { type: 'string' } },
    },
  },
};

const SYSTEM = `당신은 대한민국 부동산 경매 권리분석을 검토하는 보조 분석가입니다.
중요 원칙:
1) 인수/소멸·말소기준권리·대항력의 '판정'은 이미 결정형 엔진이 수행했습니다. 당신은 그 결과를 검토·설명하고 위험을 지적할 뿐, 새로운 법적 결론을 단정하지 마십시오.
2) 법령/판례 인용은 제공된 legalContext 안의 내용만 사용하십시오. legalContext에 없으면 인용하지 말고 citations를 빈 배열로 두십시오. 절대 조문 번호나 판례 번호를 지어내지 마십시오.
3) 이 분석은 참고용 정보이며 법률자문이 아닙니다. 유치권·법정지상권 등 등기부 외 권리는 단정하지 말고 '현장/전문가 확인 필요'로 안내하십시오.
4) 반드시 submit_verification 도구를 호출해 결과를 제출하십시오.`;

export async function verifyRights(args: VerifyArgs): Promise<VerifyOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 필요합니다');
  const client = new Anthropic({ apiKey });

  const legalBlock = (args.legalContext ?? [])
    .map((c, i) => `[${i + 1}] ${c.lawName} ${c.article}\n${c.content}`)
    .join('\n\n');

  const userContent = [
    '## 엔진 권리분석 결과(JSON)',
    '```json',
    JSON.stringify(args.engineResult, null, 2),
    '```',
    args.siteRights ? `## 사이트 제공 권리분석\n\`\`\`json\n${JSON.stringify(args.siteRights, null, 2)}\n\`\`\`` : '',
    args.sourceText ? `## 원문 문서(매각물건명세서/현황조사서/등기요약)\n${args.sourceText.slice(0, 12000)}` : '',
    legalBlock ? `## 참고 법령/판례 (legalContext — 인용은 여기서만)\n${legalBlock}` : '## 참고 법령/판례: 없음(citations는 빈 배열)',
    '',
    '위 자료를 대조하여 submit_verification 도구로 검증 결과를 제출하십시오.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const resp = await client.messages.create({
    model: VERIFY_MODEL,
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [OUTPUT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_verification' },
    messages: [{ role: 'user', content: userContent }],
  });

  const toolUse = resp.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_verification',
  );
  if (!toolUse) throw new Error('Claude가 submit_verification 도구를 호출하지 않았습니다');
  return parseVerifyOutput(toolUse.input);
}
