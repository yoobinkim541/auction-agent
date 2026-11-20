/**
 * EMPTY_REGISTRY(등기 미확보) 물건 전용 1차 소견.
 *
 * 배경: 결정형 엔진의 registry는 법원 명세서의 최선순위설정 문구에서 날짜를 뽑아 만든다
 * (crawler/adapters/courtauction.ts seniorRegistryEntries). 날짜를 못 뽑으면 엔진은
 * 말소기준권리를 못 정하고 hold로 떨어진다(shared/data-trust.ts EMPTY_REGISTRY).
 *
 * 역할: 명세서 비고에 '최선순위설정: …' 기재가 남아 있는지만 본다. 예전에는 Claude CLI에 원문을 보내 물었는데,
 * 728건을 견줘 보니 "단서 있음" 111건이 모두 이 기재가 있는 물건이었고 기재 없이 단서를 찾은 건은 0건이었다.
 * ⚠️ 새 법적 결론을 단정하지 않는다. 이 소견은 precision 평가에서 hold를 conditional로 완화만 할 수 있고
 * recommended 승격은 영구히 불가(pipeline/precision/evaluate.ts registryGapCoverable 참고).
 * 등기부 직접 열람이 반드시 필요하다는 안내를 항상 동반한다.
 */
import { seniorRegistryEntries } from '../../crawler/adapters/courtauction.ts';

export const REGISTRY_OPINION_MODEL = 'rule-v1';

export interface RegistryOpinion {
  hasClue: boolean;
  tentativeKind: string | null;
  tentativeDate: string | null;
  explanation: string;
  citations: { law: string; article: string; quote: string }[];
  requiredChecks: string[];
  confidence: 'high' | 'medium' | 'low';
}

const MANDATORY_CHECK = '등기부등본을 직접 열람해 말소기준권리(최선순위 설정)를 확인하세요 — 이 소견은 명세서 기재에 근거한 1차 판단이며 미확정입니다.';

/** notes: 매각물건명세서 비고(크롤러가 '최선순위설정: …' 줄을 덧붙여 둔 것). 날짜가 하나로 읽힐 때만 종류·날짜를 채운다. */
export function registryOpinionFromNotes(notes: string[]): RegistryOpinion {
  const senior = notes
    .map((note) => note.match(/^최선순위\s*설정\s*:\s*(\S.*)$/s)?.[1]?.trim())
    .find((value) => value);
  if (!senior) {
    return {
      hasClue: false, tentativeKind: null, tentativeDate: null,
      explanation: '매각물건명세서 비고에 최선순위설정 기재가 없습니다.',
      citations: [], requiredChecks: [MANDATORY_CHECK], confidence: 'low',
    };
  }
  const entries = seniorRegistryEntries(senior);
  const single = entries.length === 1 ? entries[0]! : null;
  return {
    hasClue: true,
    tentativeKind: single ? (single.raw ?? '').replace(/^[\d\s.\-년월일]+/, '').trim() || null : null,
    tentativeDate: single?.receiptDate ?? null,
    explanation: `매각물건명세서 비고에 '최선순위설정: ${senior.slice(0, 300)}' 기재가 있어 말소기준권리를 잠정 추정할 단서가 됩니다. `
      + (single ? '' : '날짜가 여러 개이거나 읽히지 않아 어느 권리가 기준인지는 정하지 못했습니다. ')
      + '등기부 직접 열람 없이는 확정할 수 없습니다.',
    citations: [],
    requiredChecks: [MANDATORY_CHECK],
    confidence: single ? 'medium' : 'low',
  };
}
