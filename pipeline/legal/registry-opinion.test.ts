import { describe, expect, it } from 'vitest';
import { parseRegistryOpinion } from './registry-opinion.ts';

const MANDATORY = '등기부등본을 직접 열람해 말소기준권리(최선순위 설정)를 확인하세요 — 이 소견은 AI 1차 판단이며 미확정입니다.';

describe('parseRegistryOpinion', () => {
  it('정상 출력을 정규화한다', () => {
    const r = parseRegistryOpinion(JSON.stringify({
      hasClue: true, tentativeKind: 'geunjeodang', tentativeDate: '2023-05-01',
      explanation: '설명', citations: [{ law: '민법', article: '제358조', quote: '인용' }], confidence: 'medium',
    }));
    expect(r.hasClue).toBe(true);
    expect(r.tentativeKind).toBe('geunjeodang');
    expect(r.tentativeDate).toBe('2023-05-01');
    expect(r.confidence).toBe('medium');
    expect(r.citations).toEqual([{ law: '민법', article: '제358조', quote: '인용' }]);
  });

  it('hasClue=false면 tentativeKind/Date는 모델이 뭘 줘도 강제로 null', () => {
    const r = parseRegistryOpinion(JSON.stringify({
      hasClue: false, tentativeKind: '멋대로지어낸값', tentativeDate: '2020-01-01', confidence: 'high',
    }));
    expect(r.hasClue).toBe(false);
    expect(r.tentativeKind).toBeNull();
    expect(r.tentativeDate).toBeNull();
  });

  it('requiredChecks는 모델 출력과 무관하게 항상 MANDATORY 문구 하나만 강제 포함(안전장치)', () => {
    const withExtra = parseRegistryOpinion(JSON.stringify({ hasClue: true, requiredChecks: ['다른 문구', '또 다른 문구'] }));
    expect(withExtra.requiredChecks).toEqual([MANDATORY]);

    const withoutField = parseRegistryOpinion(JSON.stringify({ hasClue: false }));
    expect(withoutField.requiredChecks).toEqual([MANDATORY]);
  });

  it('코드펜스로 감싼 출력도 파싱한다', () => {
    const r = parseRegistryOpinion('```json\n{"hasClue":true,"confidence":"low"}\n```');
    expect(r.hasClue).toBe(true);
    expect(r.confidence).toBe('low');
  });

  it('앞뒤 잡텍스트가 있어도 첫 { ~ 마지막 } 슬라이스로 파싱한다', () => {
    const r = parseRegistryOpinion('소견입니다\n{"hasClue":false,"explanation":"단서 없음"}\n끝');
    expect(r.hasClue).toBe(false);
    expect(r.explanation).toBe('단서 없음');
  });

  it('confidence가 유효값이 아니면 low로 보수적 기본값 처리한다', () => {
    expect(parseRegistryOpinion(JSON.stringify({ hasClue: true, confidence: 'super-high' })).confidence).toBe('low');
    expect(parseRegistryOpinion(JSON.stringify({ hasClue: true })).confidence).toBe('low');
  });

  it('citations 배열의 비객체 원소는 제거하고 필드 누락은 빈 문자열로 보정한다', () => {
    const r = parseRegistryOpinion(JSON.stringify({
      hasClue: true, citations: [null, 'x', { law: '민법' }],
    }));
    expect(r.citations).toEqual([{ law: '민법', article: '', quote: '' }]);
  });

  it('explanation은 800자로 잘린다', () => {
    const r = parseRegistryOpinion(JSON.stringify({ hasClue: false, explanation: 'a'.repeat(1000) }));
    expect(r.explanation.length).toBe(800);
  });
});
