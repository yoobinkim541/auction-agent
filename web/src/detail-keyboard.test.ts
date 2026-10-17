import { describe, expect, it } from 'vitest';
import { shouldIgnoreDrawerShortcut } from './detail-keyboard.ts';

describe('web/src/detail-keyboard', () => {
  it('target이 null이면 단축키를 무시하지 않는다(false 반환)', () => {
    expect(shouldIgnoreDrawerShortcut(null)).toBe(false);
  });

  it('input, textarea, select, button, a 태그에서는 단축키를 무시한다(true 반환)', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'input', 'button']) {
      const target = { tagName: tag } as unknown as EventTarget;
      expect(shouldIgnoreDrawerShortcut(target)).toBe(true);
    }
  });

  it('isContentEditable이 true인 요소에서는 단축키를 무시한다', () => {
    const target = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget;
    expect(shouldIgnoreDrawerShortcut(target)).toBe(true);
  });

  it('인터랙티브 요소 내부의 자식 요소(closest 일치)에서는 단축키를 무시한다', () => {
    const target = {
      tagName: 'SPAN',
      closest: (sel: string) => (sel.includes('button') ? ({ tagName: 'BUTTON' } as unknown as Element) : null),
    } as unknown as EventTarget;
    expect(shouldIgnoreDrawerShortcut(target)).toBe(true);
  });

  it('일반 비인터랙티브 요소(DIV, SPAN, P)는 단축키를 허용한다(false 반환)', () => {
    const target = {
      tagName: 'DIV',
      closest: () => null,
    } as unknown as EventTarget;
    expect(shouldIgnoreDrawerShortcut(target)).toBe(false);
  });
});
