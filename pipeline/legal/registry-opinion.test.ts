import { describe, expect, it } from 'vitest';
import { registryOpinionFromNotes } from './registry-opinion.ts';

describe('registryOpinionFromNotes', () => {
  it('최선순위설정 기재가 하나의 날짜로 읽히면 종류·날짜를 채운다', () => {
    const r = registryOpinionFromNotes(['-감정시점 현재 공실임', '최선순위설정: 2023. 9. 21. 근저당권']);
    expect(r).toMatchObject({ hasClue: true, tentativeKind: '근저당권', tentativeDate: '2023-09-21', confidence: 'medium' });
  });

  it('날짜가 여러 개면 단서는 있다고 보되 종류·날짜를 고르지 않는다', () => {
    const r = registryOpinionFromNotes(['최선순위설정: [목록1,3] 2021. 11. 25. 근저당권 [목록2,6] 2024. 3. 26. 근저당권']);
    expect(r).toMatchObject({ hasClue: true, tentativeKind: null, tentativeDate: null, confidence: 'low' });
  });

  it('기재가 없거나 비어 있으면 단서 없음 — 다른 줄의 근저당 언급은 단서로 보지 않는다', () => {
    expect(registryOpinionFromNotes(['인수권리: 을구 1번 근저당권 말소되지 않음', '최선순위설정: ']).hasClue).toBe(false);
    expect(registryOpinionFromNotes([]).hasClue).toBe(false);
  });

  it('어떤 경우에도 등기부 직접 열람 안내 하나만 붙는다', () => {
    for (const notes of [[], ['최선순위설정: 2022.7.5. 가압류']]) {
      const checks = registryOpinionFromNotes(notes).requiredChecks;
      expect(checks).toHaveLength(1);
      expect(checks[0]).toContain('등기부등본을 직접 열람');
    }
  });
});
