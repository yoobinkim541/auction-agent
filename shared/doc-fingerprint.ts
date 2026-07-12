/**
 * 매물 문서(명세서·현황조사 등) 내용 지문 — 재크롤 시 '실제 내용 변화'만 감지한다(⑤ 발품절감).
 * JSON 키 순서/저장 왕복(jsonb)에 흔들리지 않도록 키를 재귀 정렬한 canonical 문자열을 해시.
 */
import { createHash } from 'node:crypto';

/** 키 재귀 정렬 canonical JSON — jsonb 왕복·생성 순서 차이로 인한 허위 변경 감지 방지. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export interface DocForHash { docType: string; parsedJson?: unknown }

/** 문서 1건 지문. */
export function docHash(d: DocForHash): string {
  return createHash('md5').update(`${d.docType}|${canonicalJson(d.parsedJson ?? null)}`).digest('hex');
}

/** 문서 묶음 지문 — 타입별 정렬 후 결합(순서 무관). */
export function docsFingerprint(docs: DocForHash[]): string {
  const parts = docs.map(docHash).sort();
  return createHash('md5').update(parts.join('|')).digest('hex');
}

/** 이전↔이번 문서 묶음에서 '내용이 달라진(추가/변경/삭제) 문서 타입' 목록. */
export function changedDocTypes(prev: DocForHash[], next: DocForHash[]): string[] {
  const byType = (docs: DocForHash[]): Map<string, string> => {
    const m = new Map<string, string[]>();
    for (const d of docs) {
      const arr = m.get(d.docType) ?? [];
      arr.push(docHash(d));
      m.set(d.docType, arr);
    }
    return new Map([...m].map(([t, hs]) => [t, hs.sort().join('|')]));
  };
  const a = byType(prev);
  const b = byType(next);
  const types = new Set([...a.keys(), ...b.keys()]);
  return [...types].filter((t) => a.get(t) !== b.get(t)).sort();
}
