/**
 * 초보자용 용어 풀이 — 보고서·체크리스트에 등장한 경매 용어를 감지해 쉬운 설명을 첨부.
 */
import type { GlossaryEntry } from '../../shared/types.ts';
import { GLOSSARY_TERMS } from './glossary-data.ts';

// 핵심 용어 → 본문에서 실제로 쓰이는 표기 별칭(괄호 표제어 매칭 보강)
const ALIASES: Record<string, string[]> = {
  '인수와 소멸': ['인수', '소멸'],
  '낙찰자 인수금액': ['인수금액', '낙찰자인수'],
  '최저매각가격': ['최저매각가', '최저가'],
  '진짜안전마진': ['진짜 안전마진', '진짜마진'],
  '가등기(보전)': ['가등기'],
  '가처분(처분금지)': ['가처분'],
  '대지권미등기': ['대지권 미등기'],
  '임차권등기명령': ['임차권등기'],
  '등기사항전부증명서': ['등기부', '등기사항', '등기현황'],
  '정비구역(재개발·현금청산)': ['정비구역', '재개발', '현금청산'],
  '취득세(중과)': ['취득세'],
  '소액임차인 최우선변제': ['소액임차인', '최우선변제'],
  '배당요구종기': ['배당요구종기', '배당요구 종기'],
};
const norm = (s: string) => s.replace(/\s+/g, '');

/** 텍스트들에서 사전 용어를 찾아 등장한 GlossaryEntry 목록 반환(긴 용어 우선, 중복 제거) */
export function attachGlossary(texts: (string | undefined)[]): GlossaryEntry[] {
  const hay = norm(texts.filter(Boolean).join(' '));
  const out: GlossaryEntry[] = [];
  for (const t of GLOSSARY_TERMS) {
    const core = norm(t.term.replace(/\(.*?\)/g, ''));
    const cands = [core, ...(ALIASES[t.term] ?? []).map(norm)];
    if (cands.some((c) => c.length >= 2 && hay.includes(c))) out.push(t);
  }
  return out;
}
