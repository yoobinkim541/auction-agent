/**
 * 법령 근거 기반 리스크 평가 — 입찰 전 체크리스트의 위험 항목을 법제처 법령(legal_chunks)에
 * 매핑하고, 매물 종합 '리스크 감당 가능 여부' 등급을 산출한다.
 *
 * 등급 rubric(병렬 도메인 리서치 + 적대적 검증):
 *  - avoid     : 소유권 상실·목적물 멸실 위험(선순위 가등기·가처분·소유권말소·말소기준 부재 등) → 금액 무관 회피
 *  - severe    : 인수금액/물건하자 danger 존재 또는 진짜안전마진 음수 → 손실 큼(상한 계산 가능해야)
 *  - caution   : warn 항목 또는 진짜마진 < 10%
 *  - manageable: 깨끗 + 여유 마진
 * manageable=true 는 grade ∈ {manageable, caution} (개인 투자자 감당 가능선).
 */
import type {
  RightsAnalysisResult, LocationAnalysis, PreBidItem, LegalRisk, LegalRiskFactor, RightKind,
} from '../../shared/types.ts';
import { matchLegalChunksKeyword } from '../../shared/db.ts';
import { LEGAL_MAP, type LegalMapEntry } from './legal-map.ts';

/** 인수 등기권리 종류(RightKind) → LEGAL_MAP 키. 매핑 누락 시 해당 factor에 근거 법령이 빠지므로
 *  법령 항목이 있는 종류는 명시(키는 RightKind 타입이라 종류명 오타를 컴파일타임 검출).
 *  소유권상실 종류(보전가등기·건물철거가처분)는 전용 rf- 법령 엔트리로 연결 — 이전 KIND_KO 누락으로
 *  이 두 종류의 assumed 항목이 항상 근거 법령 없이 노출되던 버그 수정. */
const KIND_TO_LEGAL: Partial<Record<RightKind, string>> = {
  jeonse: 'assumed-전세권', jisangwon: 'assumed-지상권', imchagwon: 'assumed-임차권',
  hwanmae: 'assumed-환매', jiyeokgwon: 'assumed-지역권',
  bowjeon_gadeungi: 'rf-senior_gadeungi', cheolgeo_gacheobun: 'rf-cheolgeo_gacheobun',
};

/** 체크리스트 항목 → LEGAL_MAP 엔트리 매칭(id 정확 → 인수권리 종류 → note/luf 퍼지) */
export function lookup(item: PreBidItem): LegalMapEntry | undefined {
  if (LEGAL_MAP[item.id]) return LEGAL_MAP[item.id];
  const am = item.id.match(/^assumed-([a-z_]+)-/);
  if (am) {
    const key = KIND_TO_LEGAL[am[1] as RightKind];
    if (key && LEGAL_MAP[key]) return LEGAL_MAP[key];
  }
  if (item.id.startsWith('note-')) {
    const core = item.id.slice(5);
    for (const k of Object.keys(LEGAL_MAP)) if (k.startsWith('note-') && (k.slice(5).includes(core) || core.includes(k.slice(5)))) return LEGAL_MAP[k];
  }
  if (item.id.startsWith('luf-')) {
    for (const k of Object.keys(LEGAL_MAP)) if (k.startsWith('luf-') && item.label.includes(k.slice(4))) return LEGAL_MAP[k];
  }
  return undefined;
}

// 금액과 무관하게 회피해야 하는 소유권 상실·멸실 위험 항목
const OWNERSHIP_LOSS_IDS = new Set(['rf-senior_gadeungi', 'rf-cheolgeo_gacheobun', 'note-ownership-dispute', 'no-malso', 'note-cash-settlement']);
const isOwnershipLossKind = (k: string) => k === 'bowjeon_gadeungi' || k === 'hwanmae' || k === 'cheolgeo_gacheobun';

const GRADE_HEAD: Record<LegalRisk['grade'], string> = {
  manageable: '리스크 감당 가능 — 권리관계 비교적 깨끗',
  caution: '주의 검토 필요 — 확인 후 입찰',
  severe: '리스크 큼 — 손실 가능성, 신중히',
  avoid: '회피 권장 — 소유권 상실/멸실 위험',
};

export async function assessLegalRisk(
  rights: RightsAnalysisResult, loc: LocationAnalysis, checklist: PreBidItem[],
): Promise<LegalRisk> {
  const danger = checklist.filter((c) => c.severity === 'danger');
  const warn = checklist.filter((c) => c.severity === 'warn');

  // 위험 항목별 근거 법령 매핑(+ 법제처 코퍼스 키워드 검색으로 실제 조문 보강)
  const factors: LegalRiskFactor[] = [];
  for (const c of [...danger, ...warn].slice(0, 8)) {
    const map = lookup(c);
    let laws = (map?.laws ?? []).slice();
    if (map?.searchKeywords?.length) {
      try {
        const hits = await matchLegalChunksKeyword(map.searchKeywords.join(' '), 2);
        for (const h of hits) {
          if (h.law_name && !laws.some((l) => l.name === h.law_name && l.article === h.article)) {
            laws.push({ name: h.law_name, article: h.article, gist: (h.content || '').replace(/\s+/g, ' ').slice(0, 90) });
          }
        }
      } catch { /* 코퍼스 검색 실패 시 매핑 법령만 사용 */ }
    }
    const seenLaw = new Set<string>();
    const dedupLaws = laws.filter((l) => { const k = `${l.name}|${l.article ?? ''}`; if (seenLaw.has(k)) return false; seenLaw.add(k); return true; });
    factors.push({
      label: c.label,
      itemRisk: map?.itemRisk ?? (c.severity === 'danger' ? 'severe' : 'caution'),
      laws: dedupLaws.slice(0, 3),
      action: map?.beginnerAction,
    });
  }

  // 종합 등급
  const trueMargin = loc.acquisitionCost?.trueSafetyMargin ?? null;
  const ownershipLoss =
    checklist.some((c) => OWNERSHIP_LOSS_IDS.has(c.id)) ||
    rights.classified.some((c) => c.disposition === 'assumed' && isOwnershipLossKind(c.entry.kind));

  let grade: LegalRisk['grade'];
  if (ownershipLoss) grade = 'avoid';
  else if (danger.length > 0 || (trueMargin != null && trueMargin < 0)) grade = 'severe';
  else if (warn.length > 0 || (trueMargin != null && trueMargin < 0.1)) grade = 'caution';
  else grade = 'manageable';

  const reasoning =
    (ownershipLoss ? '소유권 상실·목적물 멸실 위험 항목이 있어 금액과 무관하게 회피 권장. ' : '') +
    `위험 ${danger.length}건·주의 ${warn.length}건` +
    (rights.assumedAmount > 0 ? `, 인수금액 ${rights.assumedAmount.toLocaleString('ko-KR')}원` : '') +
    (trueMargin != null ? `, 진짜 안전마진 ${(trueMargin * 100).toFixed(1)}%` : '') +
    '. ' +
    (grade === 'manageable' ? '인수·소유권 위험이 확인되지 않아 일반적인 입찰 검토가 가능합니다.'
      : grade === 'caution' ? '주의 항목을 원본 공부서류로 확인한 뒤 입찰하세요.'
      : grade === 'severe' ? '인수금액·하자로 손실 가능성이 큽니다. 최악의 추가부담 상한을 계산할 수 있을 때만 진입하세요.'
      : '낙찰대금을 내고도 소유권을 잃거나 건물이 철거될 수 있는 헤지 불가 위험입니다.');

  return { grade, manageable: grade === 'manageable' || grade === 'caution', headline: GRADE_HEAD[grade], reasoning, factors };
}
