/**
 * 크롤 원문(한국어) → 도메인 타입 정규화 유틸. 모두 순수함수(테스트 용이).
 */
import type { PropertyType, RightKind } from '../shared/types.ts';
import { pyeongToM2 } from '../shared/units.ts';

/** "5억3,000만" / "530,000,000" / "53,000만원" → 원(number). 실패 시 null */
export function parseKoreanMoney(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = input.replace(/[\s원]/g, '');
  if (!s) return null;

  const parseNumber = (token: string): number | null => {
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(token)) return null;
    const value = Number(token.replace(/,/g, ''));
    return Number.isSafeInteger(value) ? value : null;
  };

  // 억/만/천/백 단위 표기 (예: "5억3천만", "5억3,000만", "53,000만") — CJK 누진 파싱
  if (/[억만천백]/.test(s)) {
    const UNIT: Record<string, number> = { 억: 100_000_000, 만: 10_000, 천: 1_000, 백: 100 };
    let total = 0; // 억·만으로 확정된 누계
    let section = 0; // 천·백 누계(다음 큰 단위에 합산)
    let cur = 0; // 직전 숫자
    let sawUnit = false;
    const tokens = s.match(/\d[\d,]*|[억만천백]/g);
    if (!tokens || tokens.join('') !== s) return null;
    for (const tk of tokens) {
      const u = UNIT[tk];
      if (u !== undefined) {
        sawUnit = true;
        if (u >= 10_000) {
          total += (section + cur) * u; // 억·만: 큰 단위로 확정
          section = 0;
          cur = 0;
        } else {
          section += cur * u; // 천·백: 작은 단위
          cur = 0;
        }
      } else {
        const n = parseNumber(tk);
        if (n === null) return null;
        cur = n;
      }
    }
    total += section + cur; // 단위 없는 잔여 끝자리
    return sawUnit && total > 0 && Number.isSafeInteger(total) ? total : null;
  }
  // 순수 숫자(콤마)
  return parseNumber(s);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "보증금 1억2,000만원 전입일자 ..."처럼 라벨 뒤 금액만 안전하게 추출. */
export function extractLabeledKoreanMoney(input: string | null | undefined, labelPattern: string, stopLabels: string[]): number | null {
  if (!input) return null;
  const m = input.match(new RegExp(`${labelPattern}\\s*:?(?:\\s*금)?\\s*(.+)`, 'i'));
  if (!m?.[1]) return null;
  let segment = m[1];
  if (stopLabels.length) {
    const stopRe = new RegExp(`[\\s,;/]*(?:${stopLabels.map(escapeRegExp).join('|')})\\s*:?`, 'i');
    const stopIdx = segment.search(stopRe);
    if (stopIdx >= 0) segment = segment.slice(0, stopIdx);
  }
  return parseKoreanMoney(segment);
}

/**
 * 한 줄(날짜·순위번호·권리자·금액이 섞인 등기 텍스트)에서 '금액'만 추출.
 * parseKoreanMoney 를 줄 전체에 쓰면 날짜·순위번호 숫자까지 합쳐져 천문학적 오값이 나오므로,
 * 날짜 토큰을 먼저 제거하고 금액 후보(억/만/천 표기 또는 천단위 콤마 그룹)만 골라 최댓값을 채권액으로 본다.
 * 실패 시 null(= 금액 미상). 잘못된 큰 숫자를 만들어내는 것보다 null 이 안전하다.
 */
export function extractAmountFromText(input: string | null | undefined): number | null {
  if (!input) return null;
  const cleaned = input
    .replace(/(?<!\d)\d{4}\s*[년.\-/]\s*\d{1,2}\s*[월.\-/]\s*\d{1,2}(?!\d)/g, ' ') // YYYY.MM.DD 날짜 제거
    .replace(/(?<!\d)\d{8}(?!\d)/g, ' '); // 붙은 8자리 날짜 제거
  const cands = cleaned.match(
    /[0-9][0-9,]*\s*억(?:\s*[0-9,]+\s*(?:천만|천|만))?원?|[0-9][0-9,]*\s*(?:천만|천|만)원?|[0-9]{1,3}(?:,[0-9]{3})+/g,
  );
  if (!cands) return null;
  let best: number | null = null;
  for (const c of cands) {
    const v = parseKoreanMoney(c);
    if (v != null && (best == null || v > best)) best = v; // 채권액은 통상 최댓값
  }
  return best;
}

/** "2024.05.01" / "2024-5-1" / "2024년 5월 1일" / "20240501" → "YYYY-MM-DD" */
export function parseKoreanDate(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const s = input.trim();
  const m =
    s.match(/(?<!\d)(\d{4})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})(?!\d)/) ||
    s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // 불가능한 날짜(2023.13.45, 2월30일 등) 거부 — Date 왕복 검증
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return undefined;
  }
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const TYPE_RULES: [RegExp, PropertyType][] = [
  [/아파트/, 'apartment'],
  [/오피스텔/, 'officetel'],
  [/다세대|연립|빌라|도시형생활/, 'villa'],
  [/단독|다가구|주택/, 'house'],
  [/근린|상가|상업|점포|사무|공장|숙박/, 'commercial'],
  [/대지|토지|임야|전$|답$|과수|잡종/, 'land'],
];
export function mapPropertyType(label: string | null | undefined): PropertyType {
  if (!label) return 'other';
  for (const [re, t] of TYPE_RULES) if (re.test(label)) return t;
  return 'other';
}

export function mapRightKind(label: string | null | undefined): RightKind {
  const s = (label ?? '').replace(/\s/g, '');
  if (!s) return 'other';
  if (/근저당/.test(s)) return 'geunjeodang';
  if (/저당/.test(s)) return 'jeodang';
  if (/가압류/.test(s)) return 'gaapryu';
  if (/압류/.test(s)) return 'apryu';
  if (/담보가등기/.test(s)) return 'dambo_gadeungi';
  if (/경매개시|임의경매|강제경매/.test(s)) return 'gyeongmae_gaesi';
  if (/전세권/.test(s)) return 'jeonse';
  if (/철거|건물철거|토지인도/.test(s)) return 'cheolgeo_gacheobun';
  if (/가처분/.test(s)) return 'gacheobun';
  if (/소유권이전청구권가등기|소유권가등기|가등기/.test(s)) return 'bowjeon_gadeungi';
  if (/임차권/.test(s)) return 'imchagwon';
  if (/지상권/.test(s)) return 'jisangwon';
  if (/지역권/.test(s)) return 'jiyeokgwon';
  if (/환매/.test(s)) return 'hwanmae';
  if (/신탁/.test(s)) return 'sintak';
  if (/소유권/.test(s)) return 'soyugwon';
  return 'other';
}

/** "2024타경12345" 형태 정규화(공백 제거) */
export function normalizeCaseNo(s: string | null | undefined): string {
  return (s ?? '').replace(/\s/g, '');
}

/** 면적 "84.95㎡" / "84.95m2" / "25평" → ㎡(평이면 ×3.305785) */
export function parseAreaToM2(input: string | null | undefined): number | undefined {
  if (!input) return undefined;
  const pyeong = input.match(/([0-9.]+)\s*평/);
  if (pyeong) return Math.round(pyeongToM2(parseFloat(pyeong[1]!)) * 100) / 100;
  const m2 = input.match(/([0-9.]+)\s*(?:㎡|m2|m²)/i);
  if (m2) return parseFloat(m2[1]!);
  const num = input.match(/([0-9.]+)/);
  return num ? parseFloat(num[1]!) : undefined;
}
