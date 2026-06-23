/**
 * 입찰 전 필수 확인사항 생성 — 파싱된 모든 법률문서를 스캔해 'must-know' 항목을 정리.
 *
 * 소스: ① rule engine 결과(redFlags·인수권리·임차인·인수금액·말소기준)
 *       ② 매각물건명세서/현황조사서/감정평가요항 자연어 키워드 스캔
 *       ③ 토지이용 규제 flags  ④ 절차·비용 상시 항목
 * 각 항목은 심각도·출처·더블체크 방법을 포함. (병렬 도메인 리서치 taxonomy 87항목을 정제)
 *
 * ⚠️ 참고용. 공식 등기사항전부증명서·매각물건명세서·현황조사서 원본을 입찰 전 반드시 직접 확인.
 */
import type {
  PreBidItem, RightsAnalysisResult, LocationAnalysis, Listing, RedFlagKind,
} from '../../shared/types.ts';
import { won } from '../../shared/format.ts';

// rule engine redFlag → 체크리스트 메타(카테고리/더블체크)
const REDFLAG_META: Record<RedFlagKind, { category: PreBidItem['category']; verify: string }> = {
  yuchigwon: { category: '물건하자', verify: '현황조사서·집행기록 유치권 신고서, 점유·공사대금 근거 확인' },
  beopjeong_jisangwon: { category: '물건하자', verify: '토지·건물 소유자 동일성(등기부), 건물 매각 포함 여부 확인' },
  bunmyo_gijigwon: { category: '물건하자', verify: '현장 분묘 소재·연고 확인' },
  daejigwon_mideungi: { category: '등기인수', verify: '대지권 등기 여부·토지 등기부, 대지권 별도 매수 비용' },
  toji_byeoldo_deungi: { category: '등기인수', verify: '토지 등기부 을구(근저당 등) 인수 여부, 명세서 비고' },
  jesioe_building: { category: '물건하자', verify: '감정평가서 제시외 건물 매각 포함/제외 표기' },
  nongchi: { category: '공법규제', verify: '농지취득자격증명 발급 가능 여부(읍·면·동), 미제출 시 보증금 몰수' },
  senior_tenant: { category: '임차인배당', verify: '전입세대열람·확정일자, 매각물건명세서 임차인 현황' },
  senior_gadeungi: { category: '등기인수', verify: '등기부 갑구 가등기 종류(담보/소유권이전청구권)·순위' },
  cheolgeo_gacheobun: { category: '등기인수', verify: '등기부 처분금지가처분, 건물철거·토지인도 소송 진행' },
};

// 자연어(명세서/현황조사서/감정요항/토지이용) 키워드 스캔 규칙 — engine redFlag 미탐지 항목 보강
interface NoteRule { id: string; re: RegExp; label: string; category: PreBidItem['category']; severity: PreBidItem['severity']; detail: string; source: string; verify: string }
export const NOTE_RULES: NoteRule[] = [
  { id: 'non-extinguished-noted', re: /소멸되지\s*않는|매수인이?\s*인수|말소되지\s*않는|인수할\s*수\s*있는/, label: '명세서: 매각으로 소멸하지 않는 권리 기재', category: '등기인수', severity: 'danger', detail: '법원이 매각물건명세서에 "매수인이 인수"하는 권리를 명시함 — 인수 부담 직접 확인 필요.', source: '매각물건명세서', verify: '매각물건명세서 비고란 원문 전체 확인' },
  { id: 'ownership-dispute', re: /예고등기|소유권.*말소|원인무효|소유권에\s*관한\s*(소송|가처분)/, label: '소유권 분쟁(말소·예고등기·소송)', category: '등기인수', severity: 'danger', detail: '소유권 자체에 다툼이 있어 낙찰 후 소유권을 잃을 위험.', source: '매각물건명세서/등기현황', verify: '등기부 갑구, 관련 소송 진행 여부' },
  { id: 'cash-settlement', re: /권리산정기준일|현금청산|입주권\s*(없|불가)|조합원\s*자격/, label: '재개발 현금청산/권리산정기준일', category: '공법규제', severity: 'danger', detail: '정비구역 내 물건이라도 권리산정기준일 이후 취득 등으로 입주권 없이 현금청산 대상이 될 수 있음.', source: '매각물건명세서/토지이용', verify: '관할 구청 정비사업과, 조합원 지위 승계 여부' },
  { id: 'gongyu-jibun', re: /지분\s*매각|공유지분|[0-9]+분의\s*[0-9]+|지분경매/, label: '공유지분 매각', category: '물건하자', severity: 'danger', detail: '부동산 일부 지분만 매각 — 단독 사용·처분 불가, 공유자 우선매수·분할 소송 필요할 수 있음.', source: '등기현황/목록', verify: '등기부 갑구 지분비율, 공유자 우선매수신고 여부' },
  { id: 'wiban-building', re: /위반건축물|위법건축물|무단증축|불법\s*(증축|용도변경)|이행강제금/, label: '위반건축물', category: '물건하자', severity: 'warn', detail: '건축물대장에 위반 등재 시 시정명령·이행강제금이 매년 부과될 수 있고 대출·매도에 제약.', source: '감정평가요항/명세서', verify: '건축물대장(위반건축물 표기), 이행강제금 부과 내역' },
  { id: 'muheoga', re: /무허가|미등기\s*건물|건축물대장\s*없|사용승인\s*없/, label: '무허가·미등기 건물', category: '물건하자', severity: 'warn', detail: '등기·대장 없는 건물은 소유권·철거 위험. 제시외 건물 매각 포함 여부 확인.', source: '감정평가요항/명세서', verify: '건축물대장 존재 여부, 감정평가 제시외 표기' },
  { id: 'misnap-gwanribi', re: /관리비\s*(체납|미납|연체)|관리비\s*[\d,]{4,}\s*원|체납\s*관리비/, label: '미납 관리비(공용부분 승계)', category: '물건하자', severity: 'warn', detail: '장기 미납 관리비 중 공용부분은 낙찰자가 승계(판례). 금액이 클 수 있어 사전 확인 필수.', source: '현황조사서/명세서', verify: '관리사무소에 미납 관리비·공용/전용 구분 조회' },
  { id: 'maengji', re: /맹지|도로\s*없음|접도\s*(안|불가)|건축법상\s*도로\s*(아|없)/, label: '맹지/도로 미확보', category: '물건하자', severity: 'warn', detail: '도로에 접하지 않으면 건축·재건축 불가, 환금성 저하.', source: '감정평가요항', verify: '지적도·도로 접면, 건축 가능 여부' },
  { id: 'sintak', re: /신탁등기|수탁자|신탁원부|[가-힣]+신탁(주식회사)?/, label: '신탁등기(소유권 신탁)', category: '등기인수', severity: 'warn', detail: '신탁재산은 강제집행이 제한될 수 있어 경매 적법성·신탁원부 확인 필요.', source: '등기현황', verify: '등기부 갑구 신탁, 신탁원부 내용' },
  { id: 'military', re: /군사기지|군사시설보호|제한보호구역|통제보호구역|비행안전구역/, label: '군사보호/비행안전구역', category: '공법규제', severity: 'warn', detail: '건축 시 군 협의 필요·고도 제한 가능. 재건축·증축 시 제약.', source: '토지이용/명세서', verify: '토지이용계획확인원, 관할 부대 협의 대상 여부' },
  { id: 'city-facility', re: /(공원|학교|광장|녹지|하천|주차장)\s*저촉|도시계획시설\s*저촉/, label: '도시계획시설 저촉(수용 위험)', category: '공법규제', severity: 'warn', detail: '도시계획시설(도로·공원 등)에 저촉되면 해당 부분이 수용·보상 대상이 되어 면적 손실.', source: '토지이용', verify: '토지이용계획확인원 저촉 범위' },
  { id: 'jaemaegak', re: /재매각|재경매|매수\s*보증금[은\s]*최저.*(20|30)|특별매각조건|보증금\s*2할|보증금\s*3할/, label: '재매각(입찰보증금 20~30%)', category: '절차비용', severity: 'warn', detail: '직전 낙찰자 대금미납으로 재매각 — 입찰보증금이 최저가의 20~30%로 상향되고, 숨은 하자(명도곤란 등) 가능성.', source: '명세서/매각기일', verify: '매각물건명세서 특별매각조건, 이전 낙찰 이력' },
  { id: 'imchagwon-note', re: /임차권등기/, label: '임차권등기 임차인', category: '임차인배당', severity: 'warn', detail: '임차권등기명령 임차인은 전입을 빼도 대항력·우선변제권 유지. 선순위면 보증금 인수 위험.', source: '등기현황/명세서', verify: '임차권등기 접수일 vs 말소기준권리 순위' },
  { id: 'occupier-unknown', re: /점유관계\s*미상|폐문부재|점유자\s*미상|전입\s*미상/, label: '점유관계 미상', category: '임차인배당', severity: 'warn', detail: '점유자·전입 미확인 시 숨은 대항력 임차인 위험. 명도 난이도도 상승.', source: '현황조사서', verify: '전입세대열람, 현장 점유 확인' },
  { id: 'prev-owner-gaaprryu', re: /전\s*소유자.*(가압류|압류)|(가압류|압류).*전\s*소유자/, label: '전(前)소유자 가압류(인수 가능)', category: '등기인수', severity: 'danger', detail: '전 소유자에 대한 선순위 (가)압류는 매각으로 당연히 소멸하지 않고 인수 조건으로 매각될 수 있음(엔진은 일반 가압류를 소멸 처리하므로 별도 확인 필요).', source: '등기현황/명세서', verify: '매각물건명세서 인수 기재, 갑구 소유권이전 전후 (가)압류 순위' },
];

/** 모든 파싱 데이터를 스캔해 입찰 전 체크리스트 생성 */
export function buildPreBidChecklist(args: {
  rights: RightsAnalysisResult;
  loc: LocationAnalysis;
  listing: Listing;
  notes: string[];
  scanText: string;
  dataComplete?: boolean; // 등기 등 원천 데이터가 수집됐는지(false면 분석 신뢰 불가)
}): PreBidItem[] {
  const { rights, loc, listing } = args;
  const dataComplete = args.dataComplete !== false;
  const items: PreBidItem[] = [];
  const seen = new Set<string>();
  const push = (it: PreBidItem) => { if (!seen.has(it.id)) { seen.add(it.id); items.push(it); } };
  const text = `${args.notes.join(' ')} ${args.scanText}`.replace(/\s+/g, ' ');

  // 데이터 불완전(등기 미수집 — 차단/로드실패): 잘못된 위험 판정을 막기 위해 분석 보류 안내만.
  if (!dataComplete) {
    push({ id: 'data-incomplete', label: '⚠️ 등기 등 원천 데이터 미수집 — 분석 보류', category: '절차비용', severity: 'warn', detail: '상세페이지 등기/명세서가 수집되지 않아(사이트 접속차단 또는 로드 실패) 권리분석을 신뢰할 수 없습니다. 재수집 후 다시 분석하거나 원본을 직접 확인하세요.', source: '수집 상태', verify: listing.sourceUrl ?? '원본 상세페이지' });
    push({ id: 'verify-source', label: '원본 공부서류 직접 확인', category: '절차비용', severity: 'info', detail: '데이터가 불완전하므로 매각물건명세서·등기부 원본을 반드시 직접 확인하세요.', source: '원본 상세페이지', verify: listing.sourceUrl ?? '더낙찰옥션 상세페이지' });
    return items;
  }

  // 1) 낙찰자 인수금액 (최상위)
  if (rights.assumedAmount > 0) {
    push({
      id: 'assumed-amount', label: `낙찰자 인수금액 ${won(rights.assumedAmount)}`, category: '등기인수', severity: 'danger',
      detail: `낙찰가와 별도로 ${won(rights.assumedAmount)}을(를) 추가 인수해야 함${rights.assumedBreakdown[0] ? ` — ${rights.assumedBreakdown.map((b) => b.label).join(', ')}` : ''}.`,
      source: '예상배당표/등기·명세서', verify: '예상배당표 낙찰자인수, 매각물건명세서 인수권리',
    });
  }

  // 2) rule engine redFlags
  for (const f of rights.redFlags) {
    const meta = REDFLAG_META[f.kind];
    push({ id: `rf-${f.kind}`, label: f.message.split(' — ')[0]!, category: meta?.category ?? '물건하자', severity: f.severity, detail: f.message, source: '등기·명세서(엔진 탐지)', verify: meta?.verify ?? '매각물건명세서·등기부 확인' });
  }

  // 3) 인수되는 등기 권리(분류 결과)
  for (const c of rights.classified) {
    if (c.disposition !== 'assumed') continue;
    push({ id: `assumed-${c.entry.kind}-${c.entry.receiptDate}`, label: `인수 등기권리: ${c.entry.kind}`, category: '등기인수', severity: 'danger', detail: `${c.entry.receiptDate} ${c.entry.kind} — 말소기준권리보다 선순위로 매수인 인수. ${c.reason}`, source: '등기현황', verify: '등기부 을구/갑구 해당 권리, 명세서 인수 기재' });
  }

  // 4) 임차인 대항력/배당
  for (const [i, ta] of rights.tenants.entries()) {
    if (ta.hasOpposition) {
      const noDemand = !ta.tenant.demandedDistribution;
      push({ id: `tenant-opp-${ta.tenant.name ?? ta.tenant.moveInDate ?? i}`, label: `선순위 대항력 임차인${noDemand ? '(배당요구 안 함 — 전액 인수)' : ''}`, category: '임차인배당', severity: 'danger', detail: `대항력 있는 임차인${ta.tenant.name ? ` ${ta.tenant.name}` : ''} 보증금 ${won(ta.tenant.deposit)}. ${noDemand ? '배당요구를 하지 않아 보증금 전액을 낙찰자가 인수.' : '배당에서 미회수 잔액을 낙찰자가 인수.'}`, source: '임차인현황/등기', verify: '전입세대열람·확정일자, 배당요구 여부·종기' });
    }
  }
  if (rights.malsoBasis.entry == null) {
    push({ id: 'no-malso', label: '말소기준권리 부재(전부 인수 위험)', category: '등기인수', severity: 'danger', detail: '근저당·압류·가압류 등 말소기준권리가 없어 선순위 권리가 모두 인수될 수 있음.', source: '등기현황', verify: '등기부 전체, 매각물건명세서' });
  }
  for (const w of rights.warnings) {
    if (/말소기준일.*불일치/.test(w)) push({ id: 'malso-mismatch', label: '말소기준일 vs 명세서 최선순위 불일치', category: '등기인수', severity: 'warn', detail: w, source: '등기/명세서', verify: '매각물건명세서 최선순위 설정일자' });
  }

  // 5) 지층/지하층/반지하 — 시세 과대 추정·거주성·대출 제한 주의
  if (/지층|지하층|반지하/.test(listing.address)) {
    push({
      id: 'basement-unit',
      label: '지하/지층 호실 — 시세비교 왜곡·거주성·대출 주의',
      category: '물건하자', severity: 'warn',
      detail: '지층·지하층·반지하는 MOLIT 실거래 비교군이 지상층 기준일 수 있어 시세가 과대 산출될 수 있습니다. 주택담보대출 LTV 제한(또는 불가), 침수·채광·환기 위험, 건축물대장 용도(창고 vs 주거) 확인 필수.',
      source: '주소(자동감지)', verify: '건축물대장 용도, 현장 채광·침수 여부, 대출 한도 확인',
    });
  }

  // 6) 토지이용 규제 flags (위험만 체크리스트로)
  for (const lf of loc.landUseFlags ?? []) {
    if (lf.kind === 'info') continue;
    push({ id: `luf-${lf.label}`, label: lf.label, category: '공법규제', severity: lf.kind === 'risk' ? (lf.severity === 'high' ? 'danger' : 'warn') : 'info', detail: lf.impact ?? lf.label, source: '토지이용계획(감정평가요항)', verify: '토지이용계획확인원' });
  }

  // 7) 자연어 키워드 스캔
  for (const r of NOTE_RULES) {
    if (r.re.test(text)) push({ id: `note-${r.id}`, label: r.label, category: r.category, severity: r.severity, detail: r.detail, source: r.source, verify: r.verify });
  }

  // 8) 절차·비용 상시 항목
  const deposit = Math.round(listing.minBidPrice * 0.1);
  push({ id: 'bid-deposit', label: `입찰보증금 ${won(deposit)} (최저가 10%)`, category: '절차비용', severity: 'info', detail: `당 회차 최저매각가 ${won(listing.minBidPrice)}의 10%. 재매각 사건은 20~30%로 상향.`, source: '절차', verify: '매각물건명세서 특별매각조건(보증금 비율)' });
  push({ id: 'balance-deadline', label: '대금납부기한(미납 시 보증금 몰수)', category: '절차비용', severity: 'info', detail: '매각허가결정 확정 후 통상 약 1개월 내 잔금 전액 납부. 미납 시 보증금 몰취·재경매. 인수금액+취득세+잔금 자금계획 필요.', source: '절차', verify: '법원 대금지급기한 통지' });
  if (loc.acquisitionCost) {
    push({ id: 'acq-cost', label: `예상 취득 부대비용 ${won(loc.acquisitionCost.acqTax + loc.acquisitionCost.moveOutCost + loc.acquisitionCost.bondCost)}`, category: '절차비용', severity: 'info', detail: `취득세 ${won(loc.acquisitionCost.acqTax)}(${loc.acquisitionCost.acqTaxRatePct}%) + 명도비 ${won(loc.acquisitionCost.moveOutCost)} + 국민주택채권 ${won(loc.acquisitionCost.bondCost)}. 다주택/조정지역이면 취득세 중과.`, source: '계산', verify: '위택스 취득세, 주택도시기금 채권할인율' });
  }
  push({ id: 'registry-fresh', label: '입찰 직전 등기 재확인', category: '등기인수', severity: 'info', detail: '수집 시점 이후 신규 가압류·임차권등기·대위변제 말소 등 변동 가능 — 입찰 직전 등기사항전부증명서 재발급으로 확인.', source: '절차', verify: '인터넷등기소 등기사항전부증명서 재발급' });

  // 9) 원본 더블체크 안내(항상)
  push({ id: 'verify-source', label: '원본 공부서류 직접 확인', category: '절차비용', severity: 'info', detail: '본 분석은 사이트 파싱 기반 참고용. 매각물건명세서·현황조사서·감정평가서·등기부 원본을 입찰 전 반드시 직접 확인.', source: '원본 상세페이지', verify: listing.sourceUrl ?? '더낙찰옥션 상세페이지' });

  // 심각도 순 정렬(danger→warn→info), 카테고리 보조
  const sev = { danger: 0, warn: 1, info: 2 };
  return items.sort((a, b) => sev[a.severity] - sev[b.severity]);
}
