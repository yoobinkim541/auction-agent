import { describe, expect, it } from 'vitest';
import { canonicalJson, changedDocTypes, docsFingerprint } from './doc-fingerprint.ts';

describe('canonicalJson', () => {
  it('키 순서가 달라도 같은 문자열', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, 2] } })).toBe(canonicalJson({ a: { c: [1, 2], d: 2 }, b: 1 }));
  });
  it('undefined는 null로 정규화', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('docsFingerprint', () => {
  const docs = [
    { docType: 'sale_statement', parsedJson: { tenants: [{ name: 'A', opposition: true }] } },
    { docType: 'registry_summary', parsedJson: { entries: 3 } },
  ];
  it('순서가 달라도 같은 지문', () => {
    expect(docsFingerprint(docs)).toBe(docsFingerprint([...docs].reverse()));
  });
  it('내용이 바뀌면 지문이 달라진다', () => {
    const changed = [docs[0]!, { docType: 'registry_summary', parsedJson: { entries: 4 } }];
    expect(docsFingerprint(changed)).not.toBe(docsFingerprint(docs));
  });
});

describe('changedDocTypes', () => {
  const prev = [
    { docType: 'sale_statement', parsedJson: { tenants: 1 } },
    { docType: 'registry_summary', parsedJson: { entries: 3 } },
  ];
  it('변경된 타입만 골라낸다', () => {
    const next = [
      { docType: 'sale_statement', parsedJson: { tenants: 2 } }, // 변경
      { docType: 'registry_summary', parsedJson: { entries: 3 } }, // 동일
    ];
    expect(changedDocTypes(prev, next)).toEqual(['sale_statement']);
  });
  it('추가/삭제된 타입도 변경으로 본다', () => {
    const next = [prev[1]!, { docType: 'survey_report', parsedJson: {} }];
    expect(changedDocTypes(prev, next)).toEqual(['sale_statement', 'survey_report']);
  });
  it('완전 동일하면 빈 배열', () => {
    expect(changedDocTypes(prev, [...prev].reverse())).toEqual([]);
  });
});
