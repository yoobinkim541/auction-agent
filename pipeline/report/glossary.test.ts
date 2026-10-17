import { describe, expect, it } from 'vitest';
import { attachGlossary } from './glossary.ts';

describe('attachGlossary', () => {
  it('텍스트에 등장하는 용어를 감지해 사전 항목을 반환한다', () => {
    const text = '이 물건은 말소기준권리보다 앞선 선순위 대항력 임차인이 있어 보증금 인수 위험이 있습니다.';
    const terms = attachGlossary([text]);
    const termNames = terms.map((t) => t.term);

    expect(termNames).toContain('말소기준권리');
    expect(termNames).toContain('대항력');
    expect(termNames).toContain('인수와 소멸');
  });

  it('별칭(ALIAS) 표기로도 원본 표제어를 찾아낸다', () => {
    // "인수금액" -> "낙찰자 인수금액"
    // "최저가" -> "최저매각가격"
    // "진짜마진" -> "진짜안전마진"
    const text = '최저가 2억원, 예상 인수금액 5천만원으로 진짜마진이 부족합니다.';
    const terms = attachGlossary([text]);
    const termNames = terms.map((t) => t.term);

    expect(termNames).toContain('최저매각가격');
    expect(termNames).toContain('낙찰자 인수금액');
    expect(termNames).toContain('진짜안전마진');
  });

  it('공백 차이가 있어도 정규화하여 매칭한다', () => {
    const text = '진짜 안전마진 과 배당요구 종기 확인 필요';
    const terms = attachGlossary([text]);
    const termNames = terms.map((t) => t.term);

    expect(termNames).toContain('진짜안전마진');
    expect(termNames).toContain('배당요구종기');
  });

  it('중복 언급되어도 중복 없이 1회만 포함한다', () => {
    const text1 = '말소기준권리 확인 필요';
    const text2 = '말소기준권리 이후 권리는 소멸';
    const terms = attachGlossary([text1, text2]);
    const count = terms.filter((t) => t.term === '말소기준권리').length;

    expect(count).toBe(1);
  });

  it('빈 배열이나 undefined/null 항목은 빈 결과를 반환한다', () => {
    expect(attachGlossary([])).toEqual([]);
    expect(attachGlossary([undefined, '', undefined])).toEqual([]);
  });
});
