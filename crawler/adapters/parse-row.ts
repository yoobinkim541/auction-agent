/**
 * 더낙찰옥션 결과 목록 '행 텍스트' → Listing 파싱(순수함수, 네트워크 비의존 → 테스트 대상).
 * deonakchal.ts(Playwright)는 행 innerText 와 productId 만 뽑아 이 함수에 넘긴다.
 */
import type { Listing } from '../../shared/types.ts';
import { normalizeCaseNo, mapPropertyType, parseAreaToM2, extractAmountFromText } from '../normalize.ts';

export interface ParsedRow { listing: Listing; notes: string[]; productId?: string }

/** 입찰 불가(종결/취하/낙찰 등) 상태 — 수집 제외 */
export const TERMINAL = /(배당종결|취하|기각|각하|낙찰|대금납부|^배당|취소)/;

export const FLAG_TOKENS = ['유치권', '법정지상권', '분묘', '대지권미등기', '토지별도등기', '임금채권', '대항력있는임차인', '선순위', '지분', '농지', '제시외'];

/** 라벨(예: '감정가') 뒤 ~ 다음 라벨 전까지 구간에서 금액만 추출 */
function amountBetween(label: string, text: string, stops: string[]): number | null {
  const idx = text.indexOf(label);
  if (idx < 0) return null;
  let rest = text.slice(idx + label.length);
  for (const s of stops) {
    const j = rest.indexOf(s);
    if (j >= 0) rest = rest.slice(0, j);
  }
  return extractAmountFromText(rest);
}

export function parseResultRowText(text: string, opts: { productId?: string; sourceUrl: string }): ParsedRow | null {
  const head = text.match(/(\S+계)\s+(20\d\d-\d{3,6}(?:-\d+)?)\s+\[([^\]]+)\]/);
  if (!head) return null;
  const [, court, caseNo, typeLabel] = head;

  // 상태 키워드 — (NN%) 비율은 옵션. 낙찰/취하 등이 비율 없이 표기돼도 종결로 인식해 제외(과거: % 없으면 통과되던 버그).
  const status = text.match(
    /(신건|유찰|진행|정지|배당종결|취하|기각|각하|낙찰|변경|재진행|재매각|미진행|대금납부|배당)(?:\s*\d+회)?\s*(?:\((\d+)%\))?/,
  );
  if (status && TERMINAL.test(status[1]!)) return null; // 진행 매물만 수집

  const failCountM = text.match(/(?:유찰|재진행)\s*(\d+)회/);
  const failCount = failCountM ? parseInt(failCountM[1]!, 10) : 0;

  // 감정가/최저가 — 억·만·천 표기와 라벨 사이 토큰 변형에 견디도록 구간 추출(과거: 인접 정규식 실패 시 0 → 안전마진 100% 오탐)
  const appraisalValue = amountBetween('감정가', text, ['최저가']) ?? 0;
  const minBidPrice = amountBetween('최저가', text, ['건물', '토지', '감정가']) ?? 0;
  const addrM = text.match(/((?:서울특별시|인천광역시|경기도)[^[]*?)\s*(?:건물|토지|감정가)/);
  const bldM = text.match(/건물\s*([\d.]+)\s*㎡/);
  const dates = text.match(/20\d\d-\d\d-\d\d/g) ?? [];
  const notes = FLAG_TOKENS
    .filter((t) => new RegExp(`\\[[^\\]]*${t}[^\\]]*\\]`).test(text))
    .map((t) => `목록 특수권리 표기: ${t}`);
  if (!appraisalValue || !minBidPrice) notes.push('감정가/최저가 자동파싱 실패 — 원문 확인 필요');

  return {
    listing: {
      caseNo: normalizeCaseNo(caseNo),
      court: court!,
      address: addrM ? addrM[1]!.trim() : '(소재지 미상)',
      propertyType: mapPropertyType(typeLabel),
      appraisalValue,
      minBidPrice,
      minBidRatio: status && status[2] ? parseInt(status[2]!, 10) : undefined,
      failCount,
      saleDate: dates.length ? dates[dates.length - 1] : undefined,
      areaM2: bldM ? parseFloat(bldM[1]!) : parseAreaToM2(text),
      isCollectiveBuilding: /아파트|오피스텔|다세대|연립|도시형생활/.test(typeLabel!),
      source: 'deonakchal',
      sourceUrl: opts.sourceUrl,
      rawJson: { rowText: text, status: status?.[1] },
      crawledAt: new Date().toISOString(),
    },
    notes,
    productId: opts.productId,
  };
}
