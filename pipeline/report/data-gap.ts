/**
 * 권리분석을 보류해야 하는 자료 공백 판정.
 *
 * 법원경매 원천에는 등기부등본이 없다. 말소기준은 매각물건명세서의 "최선순위설정"에서만 나오는데,
 * 명세서는 매각기일이 가까워져야 공개된다(실측: 매각 14일 이내에 받은 상세는 80~97%가 최선순위설정 보유,
 * 15~21일 전에 받은 상세는 7~45%). 그래서 "비어 있다"의 원인을 셋으로 나눠 사용자에게 다르게 안내한다.
 */
export type DataGap =
  | 'no_docs'            // 상세·명세서를 한 번도 받지 못함(수집 대기·접속 차단)
  | 'statement_pending'  // 명세서 공개 전에 받은 상세 — 공개 후 재수집하면 채워질 가능성이 높음
  | 'statement_blank';   // 공개 창 안에서 받았는데도 최선순위설정·임차인 기재가 없음 — 재수집해도 같음

/** 명세서 공개 창(일) — 매각기일 이 일수 이내에 받은 상세는 명세서가 공개된 것으로 본다. 크롤러 임박 재수집 창과 같은 값. */
export const STATEMENT_PUBLISH_DAYS = 14;

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;

export function detectDataGap(args: {
  docCount: number;
  registryCount: number;
  tenantCount: number;
  siteAssumed: number | null;
  saleDate?: string | Date; // 매각기일(KST 날짜). node-pg는 DATE 컬럼을 로컬 자정 Date로 넘긴다
  docsFetchedAt?: Date;    // 문서를 마지막으로 받은 시각
}): DataGap | null {
  if (args.registryCount > 0 || args.siteAssumed != null || args.tenantCount > 0) return null;
  if (args.docCount === 0) return 'no_docs';
  const saleDay = args.saleDate instanceof Date
    ? Date.UTC(args.saleDate.getFullYear(), args.saleDate.getMonth(), args.saleDate.getDate())
    : args.saleDate ? Date.parse(`${args.saleDate.slice(0, 10)}T00:00:00Z`) : NaN;
  if (!Number.isFinite(saleDay) || !args.docsFetchedAt) return 'statement_pending';
  const fetchedKstDay = Math.floor((args.docsFetchedAt.getTime() + KST_OFFSET_MS) / DAY_MS) * DAY_MS;
  return (saleDay - fetchedKstDay) / DAY_MS > STATEMENT_PUBLISH_DAYS ? 'statement_pending' : 'statement_blank';
}

/** 공백별 안내 문구. short = 점수 사유·배지, headline/summary/rights = 보고서, label/detail = 체크리스트. */
export const DATA_GAP_TEXT: Record<DataGap, {
  short: string; headline: string; summary: string; rights: string; label: string; detail: string;
}> = {
  no_docs: {
    short: '명세서 미수집',
    headline: '상세·명세서 미수집 — 재수집 후 분석 필요',
    summary: '상세·매각물건명세서를 아직 받지 못해 권리분석 보류',
    rights: '명세서 미수집 — 권리분석 불가(재수집 필요).',
    label: '상세·명세서 미수집 — 분석 보류',
    detail: '법원경매 상세(매각물건명세서)를 아직 받지 못했습니다(수집 대기 또는 접속 차단). 다음 수집에서 받으면 다시 분석합니다.',
  },
  statement_pending: {
    short: '명세서 공개 전',
    headline: '명세서 공개 전 수집 — 최선순위설정·임차인 미확인, 공개 후 재수집 필요',
    summary: '상세를 받은 시점에 매각물건명세서가 공개되지 않아 권리분석 보류(명세서는 보통 매각기일 1~2주 전에 공개)',
    rights: '명세서 공개 전 — 최선순위설정·임차인 미확인(공개 후 재수집 필요).',
    label: '명세서 공개 전 수집 — 분석 보류',
    detail: '상세를 받은 시점에는 매각물건명세서의 최선순위설정·임차인 정보가 아직 없었습니다. 명세서는 보통 매각기일 1~2주 전에 공개되며, 그 뒤 재수집되면 다시 분석합니다.',
  },
  statement_blank: {
    short: '명세서 기재 없음',
    headline: '명세서에 최선순위설정·임차인 기재 없음 — 등기부 직접 확인 필요',
    summary: '매각물건명세서에 최선순위설정·임차인 기재가 없어 말소기준을 정할 수 없음 — 권리분석 보류',
    rights: '명세서에 최선순위설정·임차인 기재 없음 — 말소기준 미확정(등기부 직접 확인).',
    label: '명세서에 최선순위설정 기재 없음 — 분석 보류',
    detail: '공개된 매각물건명세서에 최선순위설정(말소기준)과 임차인 기재가 없습니다. 등기사항전부증명서로 말소기준권리를 직접 확인하세요.',
  },
};
