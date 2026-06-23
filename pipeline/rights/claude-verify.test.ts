import { describe, it, expect } from 'vitest';
import { parseVerifyOutput } from './claude-verify.ts';
import { extractJson } from './claude-verify-cli.ts';

describe('parseVerifyOutput', () => {
  it('완전한 객체는 정규화해 보존', () => {
    const raw = {
      agrees: true,
      discrepancies: [{ field: 'a', engineSays: 'b', concern: 'c' }],
      explanation: 'e', riskSummary: 'r',
      citations: [{ law: 'L', article: '1', quote: 'q' }],
      recommendedChecks: ['x', 'y'],
    };
    expect(parseVerifyOutput(raw)).toEqual(raw);
  });

  it('필수 필드 누락 → 안전 기본값', () => {
    expect(parseVerifyOutput({})).toEqual({
      agrees: false, discrepancies: [], explanation: '', riskSummary: '', citations: [], recommendedChecks: [],
    });
  });

  it('비객체 입력(null/문자열) → 전부 기본값(throw 안 함)', () => {
    expect(parseVerifyOutput(null).agrees).toBe(false);
    expect(parseVerifyOutput('oops').discrepancies).toEqual([]);
  });

  it('배열 내 비정상 원소·여분 필드·잘못된 타입 제거', () => {
    const r = parseVerifyOutput({
      agrees: 'yes',                                  // boolean 아님 → 보수적 false
      discrepancies: [null, 'x', { field: 'f' }],     // 비객체 제거, 누락필드 보정
      recommendedChecks: ['a', '', null],             // 빈/null 제거
      extra: 1,                                        // 여분 필드 제거
    });
    expect(r.agrees).toBe(false);
    expect(r.discrepancies).toEqual([{ field: 'f', engineSays: '', concern: '' }]);
    expect(r.recommendedChecks).toEqual(['a']);
    expect('extra' in r).toBe(false);
  });
});

describe('extractJson (CLI 출력)', () => {
  it('코드펜스 감싼 출력 파싱+정규화', () => {
    const r = extractJson('```json\n{"agrees":true,"explanation":"ok"}\n```');
    expect(r.agrees).toBe(true);
    expect(r.explanation).toBe('ok');
    expect(r.citations).toEqual([]); // 누락 필드 보정
  });

  it('앞뒤 잡텍스트가 있어도 첫 { ~ 마지막 } 슬라이스', () => {
    const r = extractJson('설명입니다\n{"agrees":false,"riskSummary":"주의"}\n끝');
    expect(r.riskSummary).toBe('주의');
    expect(r.recommendedChecks).toEqual([]);
  });
});
