/**
 * 크롤 원문(한국어) → 도메인 타입 정규화 유틸. 모두 순수함수(테스트 용이).
 */
import type { PropertyType, RightKind } from '../shared/types.ts';

/** "5억3,000만" / "530,000,000" / "53,000만원" → 원(number). 실패 시 null */
export function parseKoreanMoney(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = input.replace(/[\s원]/g, '');
  if (!s) return null;

  // 억/만 단위 표기
  if (/[억만]/.test(s)) {
    let total = 0;
    const eok = s.match(/([0-9,]+)\s*억/);
    const man = s.match(/([0-9,]+)\s*만/);
    if (eok) total += parseInt(eok[1]!.replace(/,/g, ''), 10) * 100_000_000;
    if (man) total += parseInt(man[1]!.replace(/,/g, ''), 10) * 10_000;
    // "억"만 있고 "만" 없을 때 남은 숫자 처리는 생략(드묾)
    return total > 0 ? total : null;
  }
  // 순수 숫자(콤마)
  const digits = s.replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : null;
}

/** "2024.05.01" / "2024-5-1" / "2024년 5월 1일" / "20240501" → "YYYY-MM-DD" */
export function parseKoreanDate(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const s = input.trim();
  let m =
    s.match(/(\d{4})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})/) ||
    s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const TYPE_RULES: [RegExp, PropertyType][] = [
  [/아파트/, 'apartment'],
  [/오피스텔/, 'officetel'],
  [/다세대|연립|빌라/, 'villa'],
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
  if (pyeong) return Math.round(parseFloat(pyeong[1]!) * 3.305785 * 100) / 100;
  const m2 = input.match(/([0-9.]+)\s*(?:㎡|m2|m²)/i);
  if (m2) return parseFloat(m2[1]!);
  const num = input.match(/([0-9.]+)/);
  return num ? parseFloat(num[1]!) : undefined;
}
