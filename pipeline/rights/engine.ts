/**
 * 권리분석 결정형 rule engine.
 *
 * 설계 원칙: 우선순위/인수·소멸 로직은 100% 결정형 코드로 계산한다.
 * (LLM은 별도 단계에서 문서 추출과 인용·설명만 담당 — claude-verify.ts)
 *
 * 면책: 본 엔진의 산출은 참고용이며 법률자문이 아니다. 등기부·현황조사서·매각물건명세서의
 * 실제 기재와 다를 수 있고, 유치권 등 등기부 외 권리는 자동 판정이 불가하여 플래그만 한다.
 */

import type {
  RightsInput,
  RegistryEntry,
  RightKind,
  Tenant,
  ClassifiedRight,
  TenantAnalysis,
  DistributionLine,
  RedFlag,
  RightsAnalysisResult,
  Disposition,
} from '../../shared/types.ts';
import { evaluateSohaek } from './sohaek-table.ts';

export const ENGINE_VERSION = '0.1.0';

// ── 날짜 유틸 (ISO YYYY-MM-DD) ───────────────────────────────────
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function maxDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

// ── 권리 종류 분류 ───────────────────────────────────────────────
/** 말소기준권리 후보 (최선순위 하나가 말소기준이 됨) */
const MALSO_CANDIDATES: ReadonlySet<RightKind> = new Set([
  'geunjeodang', 'jeodang', 'apryu', 'gaapryu', 'dambo_gadeungi', 'gyeongmae_gaesi',
]);
/** 배당으로 소멸하는 금전/담보 권리 (순위 무관 소멸) */
const MONEY_KINDS: ReadonlySet<RightKind> = new Set([
  'geunjeodang', 'jeodang', 'apryu', 'gaapryu', 'dambo_gadeungi', 'gyeongmae_gaesi',
]);
/** 담보물권(소액임차인 기준일 산정용) */
const SECURITY_KINDS: ReadonlySet<RightKind> = new Set([
  'geunjeodang', 'jeodang', 'dambo_gadeungi', 'jeonse',
]);

/** 등기 정렬: 접수일자 → 접수번호 → 순위번호 (오름차순 = 선순위 우선) */
export function compareEntries(a: RegistryEntry, b: RegistryEntry): number {
  if (a.receiptDate !== b.receiptDate) return a.receiptDate < b.receiptDate ? -1 : 1;
  const an = a.receiptNo ?? Number.MAX_SAFE_INTEGER;
  const bn = b.receiptNo ?? Number.MAX_SAFE_INTEGER;
  if (an !== bn) return an - bn;
  const ar = a.rankNo ?? Number.MAX_SAFE_INTEGER;
  const br = b.rankNo ?? Number.MAX_SAFE_INTEGER;
  return ar - br;
}

/** 말소기준권리 = 후보 중 최선순위 */
export function findMalsoBasis(registry: RegistryEntry[]): RegistryEntry | null {
  const candidates = registry.filter((e) => MALSO_CANDIDATES.has(e.kind)).sort(compareEntries);
  return candidates[0] ?? null;
}

/** 첫 담보물권 설정일 (소액임차인 시행령 버전 선택용) */
function firstSecurityDate(registry: RegistryEntry[]): string | null {
  const secs = registry.filter((e) => SECURITY_KINDS.has(e.kind)).sort(compareEntries);
  return secs[0]?.receiptDate ?? null;
}

// ── 인수/소멸 분류 ───────────────────────────────────────────────
function classifyOne(
  entry: RegistryEntry,
  malso: RegistryEntry | null,
): { disposition: Disposition; reason: string } {
  if (malso && entry === malso) {
    return { disposition: 'extinguished', reason: '말소기준권리 — 매각으로 소멸' };
  }
  if (MONEY_KINDS.has(entry.kind)) {
    return { disposition: 'extinguished', reason: '담보물권·(가)압류 등 금전권리는 배당 후 소멸' };
  }
  if (entry.kind === 'cheolgeo_gacheobun') {
    return { disposition: 'assumed', reason: '건물철거·토지인도 가처분은 순위와 무관하게 인수' };
  }
  const senior = malso === null ? true : compareEntries(entry, malso) < 0;

  if (entry.kind === 'jeonse') {
    if (senior) {
      return entry.demandedDistribution
        ? { disposition: 'extinguished', reason: '선순위 전세권이나 배당요구하여 소멸' }
        : { disposition: 'assumed', reason: '선순위 전세권(배당요구 없음) — 인수' };
    }
    return { disposition: 'extinguished', reason: '후순위 전세권 — 소멸' };
  }

  // 지상권/지역권/(보전)가등기/환매/임차권/가처분/기타 비금전권리
  if (senior) {
    return { disposition: 'assumed', reason: '말소기준권리보다 선순위 — 인수' };
  }
  return { disposition: 'extinguished', reason: '말소기준권리보다 후순위 — 소멸' };
}

// ── 임차인 분석 ─────────────────────────────────────────────────
function analyzeTenant(
  t: Tenant,
  malsoDate: string | null,
  address: string,
  secDate: string | null,
  demandDeadline: string | undefined,
): TenantAnalysis {
  const notes: string[] = [];
  // 대항요건: 점유(인도) + 전입신고 → 익일 0시 대항력 발생
  const reqDate = maxDate(t.occupancyDate, t.moveInDate);
  const hasRequisites = t.occupied && !!t.moveInDate && !!reqDate;
  const oppositionDate = hasRequisites && reqDate ? addDays(reqDate, 1) : null;

  // 대항력: 발생일이 말소기준일 이하(같은 날이면 0시 규칙으로 임차인 우선)
  let hasOpposition = false;
  if (oppositionDate) {
    hasOpposition = malsoDate === null ? true : oppositionDate <= malsoDate;
  }
  if (!t.moveInDate) notes.push('전입신고일 미상 — 대항력 판단 불가(보수적으로 무대항력 처리)');
  if (!t.occupied) notes.push('점유 미확인 — 대항요건 불충족');

  // 우선변제권: 대항요건 + 확정일자
  const hasPriorityRepayment = hasRequisites && !!t.fixedDate;
  const priorityDate = hasPriorityRepayment ? maxDate(oppositionDate ?? undefined, t.fixedDate) ?? null : null;
  if (hasRequisites && !t.fixedDate) notes.push('확정일자 없음 — 우선변제권 없음(최우선변제만 가능)');

  // 최우선변제(소액임차인) — 담보물권 최초 설정일 기준
  const baseDate = secDate ?? malsoDate ?? oppositionDate ?? '2023-02-21';
  const sohaek = evaluateSohaek(t.deposit, address, baseDate);
  if (!sohaek.tierCertain) notes.push(`지역등급(${sohaek.tier}) 추정 — 소액임차인 기준 검증 필요`);

  // 배당요구 적법성 (종기 이내)
  let validDemand = t.demandedDistribution;
  if (t.demandedDistribution && demandDeadline && t.demandDate) {
    validDemand = t.demandDate <= demandDeadline;
    if (!validDemand) notes.push('배당요구가 종기 이후 — 배당 제외(대항력 있으면 전액 인수)');
  }

  return {
    tenant: t,
    oppositionDate,
    hasOpposition,
    hasPriorityRepayment,
    priorityDate,
    isSmallTenant: sohaek.isSmallTenant,
    minPriorityAmount: sohaek.maxPriority,
    validDemand,
    notes,
  };
}

// ── 배당 시뮬레이션 (간이 추정) ──────────────────────────────────
interface DistResult {
  lines: DistributionLine[];
  distributedToTenant: Map<Tenant, number>;
}
function simulateDistribution(
  available: number,
  registry: RegistryEntry[],
  tenants: TenantAnalysis[],
): DistResult {
  const lines: DistributionLine[] = [];
  const distributedToTenant = new Map<Tenant, number>();
  let pool = Math.max(0, available);
  let rank = 0;

  // 1순위: 최우선변제(소액임차인). 배당재원의 1/2 한도.
  const smallCap = Math.floor(Math.max(0, available) / 2);
  let smallUsed = 0;
  for (const ta of tenants) {
    if (ta.isSmallTenant && ta.validDemand && ta.minPriorityAmount > 0) {
      const pay = Math.min(ta.minPriorityAmount, pool, smallCap - smallUsed);
      if (pay > 0) {
        pool -= pay;
        smallUsed += pay;
        distributedToTenant.set(ta.tenant, (distributedToTenant.get(ta.tenant) ?? 0) + pay);
        lines.push({
          rank: ++rank,
          label: '최우선변제(소액임차인)',
          claimant: ta.tenant.name,
          amount: pay,
          basis: `보증금 ${won(ta.tenant.deposit)} / 최우선 한도 ${won(ta.minPriorityAmount)}`,
        });
      }
    }
  }

  // 2순위: 확정일자부 임차인 + 담보물권을 일자(우선변제권 발생일/접수일) 순으로 배당
  type Claim = { date: string; label: string; claimant?: string; amount: number; tenant?: Tenant };
  const claims: Claim[] = [];
  for (const ta of tenants) {
    if (ta.hasPriorityRepayment && ta.validDemand && ta.priorityDate) {
      const already = distributedToTenant.get(ta.tenant) ?? 0;
      const remain = Math.max(0, ta.tenant.deposit - already);
      if (remain > 0) {
        claims.push({ date: ta.priorityDate, label: '확정일자부 임차인 우선변제', claimant: ta.tenant.name, amount: remain, tenant: ta.tenant });
      }
    }
  }
  for (const e of registry) {
    if (e.kind === 'geunjeodang' || e.kind === 'jeodang') {
      claims.push({ date: e.receiptDate, label: `${kindLabel(e.kind)} 배당`, claimant: e.holder, amount: e.amount ?? 0 });
    }
  }
  claims.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const c of claims) {
    if (pool <= 0) break;
    const pay = Math.min(c.amount, pool);
    if (pay <= 0) continue;
    pool -= pay;
    if (c.tenant) distributedToTenant.set(c.tenant, (distributedToTenant.get(c.tenant) ?? 0) + pay);
    lines.push({ rank: ++rank, label: c.label, claimant: c.claimant, amount: pay, basis: `설정/확정일 ${c.date}` });
  }

  return { lines, distributedToTenant };
}

// ── 인수금액 산정 ───────────────────────────────────────────────
function computeAssumed(
  classified: ClassifiedRight[],
  tenants: TenantAnalysis[],
  dist: DistResult,
): { total: number; breakdown: { label: string; amount: number; reason: string }[] } {
  const breakdown: { label: string; amount: number; reason: string }[] = [];
  let total = 0;

  // 대항력 임차인의 미회수 보증금 인수
  for (const ta of tenants) {
    if (!ta.hasOpposition) continue;
    const paid = dist.distributedToTenant.get(ta.tenant) ?? 0;
    const unrecovered = Math.max(0, ta.tenant.deposit - paid);
    if (unrecovered > 0) {
      total += unrecovered;
      breakdown.push({
        label: `대항력 임차인 보증금 인수${ta.tenant.name ? ` (${ta.tenant.name})` : ''}`,
        amount: unrecovered,
        reason: ta.validDemand
          ? '대항력 있는 임차인의 배당 부족분을 매수인이 인수'
          : '대항력 있으나 배당요구 없음 — 보증금 전액 매수인 인수',
      });
    }
  }

  // 인수되는 전세권(배당요구 없는 선순위 전세권 등)
  for (const c of classified) {
    if (c.disposition !== 'assumed') continue;
    if (c.entry.kind === 'jeonse') {
      const amt = c.entry.amount ?? 0;
      total += amt;
      breakdown.push({ label: '선순위 전세권 인수', amount: amt, reason: c.reason });
    }
    // 가등기/지상권/가처분 등은 금액 환산이 어려워 레드플래그로 처리(금액 0)
  }

  return { total, breakdown };
}

// ── 레드플래그 스캔 ─────────────────────────────────────────────
function scanRedFlags(
  notes: string[],
  classified: ClassifiedRight[],
  tenants: TenantAnalysis[],
): RedFlag[] {
  const flags: RedFlag[] = [];
  const text = notes.join(' ');
  const add = (kind: RedFlag['kind'], severity: RedFlag['severity'], message: string, needsHumanReview: boolean) =>
    flags.push({ kind, severity, message, needsHumanReview });

  if (/유치권/.test(text)) add('yuchigwon', 'danger', '유치권 신고/주장 존재 — 인수 위험, 별도 검토 필수', true);
  if (/법정지상권|지상권.*여지|관습.*지상권/.test(text)) add('beopjeong_jisangwon', 'danger', '법정지상권 성립 여지 — 토지/건물 별도 검토 필요', true);
  if (/분묘|묘지/.test(text)) add('bunmyo_gijigwon', 'warn', '분묘기지권 가능성', true);
  if (/대지권\s*미등기|대지권\s*없음|대지권\s*미정리/.test(text)) add('daejigwon_mideungi', 'danger', '대지권 미등기 — 토지 별도 권리 확인 필요', true);
  if (/토지별도등기/.test(text)) add('toji_byeoldo_deungi', 'danger', '토지별도등기 — 토지상 권리 인수 위험', true);
  if (/제시\s*외|제시외/.test(text)) add('jesioe_building', 'warn', '제시외 건물 존재 — 일괄/제외 여부 확인', false);
  if (/농지취득|농취|농지자격/.test(text)) add('nongchi', 'warn', '농지취득자격증명 필요 가능성', false);

  for (const ta of tenants) {
    if (ta.hasOpposition) {
      add('senior_tenant', 'danger', `선순위 대항력 임차인 존재 — 보증금 인수 위험${ta.tenant.name ? ` (${ta.tenant.name})` : ''}`, false);
    }
  }
  for (const c of classified) {
    if (c.disposition === 'assumed' && c.entry.kind === 'bowjeon_gadeungi') {
      add('senior_gadeungi', 'danger', '선순위 (보전)가등기 — 소유권 상실 위험, 검토 필수', true);
    }
    if (c.entry.kind === 'cheolgeo_gacheobun') {
      add('cheolgeo_gacheobun', 'danger', '건물철거 가처분 — 건물 철거 위험', true);
    }
  }
  return flags;
}

// ── 메인 ────────────────────────────────────────────────────────
export function analyzeRights(input: RightsInput): RightsAnalysisResult {
  const warnings: string[] = [];
  const registry = [...input.registry].sort(compareEntries);

  const malso = findMalsoBasis(registry);
  const malsoDate = malso?.receiptDate ?? null;
  if (!malso) warnings.push('말소기준권리 후보(저당/근저당/(가)압류/담보가등기/경매개시)가 없음 — 모든 비금전권리를 인수로 보수 처리');

  // 매각물건명세서 최선순위 설정일자와 교차검증
  if (input.statementSeniorDate && malsoDate && input.statementSeniorDate !== malsoDate) {
    warnings.push(`말소기준일(${malsoDate})이 명세서 최선순위 설정일자(${input.statementSeniorDate})와 불일치 — 등기 재확인 필요`);
  }

  // 분류 (소유권 항목은 제외)
  const classified: ClassifiedRight[] = registry
    .filter((e) => e.kind !== 'soyugwon')
    .map((e) => ({ entry: e, ...classifyOne(e, malso) }));

  // 집합건물인데 토지등기 누락 시 경고
  if (input.listing.isCollectiveBuilding && !input.landRegistry) {
    warnings.push('집합건물이나 토지 등기부 미제공 — 토지별도등기/대지권 확인 권장');
  }

  // 임차인
  const secDate = firstSecurityDate(registry);
  const tenants = input.tenants.map((t) =>
    analyzeTenant(t, malsoDate, input.listing.address, secDate, input.listing.demandDeadline),
  );

  // 배당 시뮬 (최저매각가 기준)
  const dist = simulateDistribution(input.listing.minBidPrice ?? 0, registry, tenants);

  // 인수금액
  const { total: assumedAmount, breakdown: assumedBreakdown } = computeAssumed(classified, tenants, dist);

  // 레드플래그
  const redFlags = scanRedFlags(input.notes ?? [], classified, tenants);

  // 위험등급
  // 일부 경고(말소기준 불일치/부재)는 caution을 유발하지만, "집합건물 토지등기 미제공" 같은
  // 일반 정보성 경고는 표시만 하고 등급을 끌어내리지 않는다(아파트가 늘 caution이 되는 것 방지).
  const substantiveWarn = warnings.some((w) => w.includes('불일치') || w.includes('말소기준권리 후보'));
  const needsReview = redFlags.some((f) => f.needsHumanReview);
  const hasDanger = redFlags.some((f) => f.severity === 'danger');
  const hasWarn = redFlags.some((f) => f.severity === 'warn') || substantiveWarn;
  let riskGrade: RightsAnalysisResult['riskGrade'];
  if (needsReview) riskGrade = 'review_required';
  else if (assumedAmount > 0 || hasDanger) riskGrade = 'risky';
  else if (hasWarn) riskGrade = 'caution';
  else riskGrade = 'clean';

  const isClean = assumedAmount === 0 && !hasDanger && !needsReview;

  return {
    caseNo: input.listing.caseNo,
    malsoBasis: {
      entry: malso,
      date: malsoDate,
      note: malso ? `${kindLabel(malso.kind)} (${malsoDate})` : '말소기준권리 없음',
    },
    classified,
    tenants,
    distribution: dist.lines,
    assumedAmount,
    assumedBreakdown,
    maxSafeBid: null, // 시세 확보 후 입지/점수 단계에서 산정
    redFlags,
    riskGrade,
    isClean,
    warnings,
    engineVersion: ENGINE_VERSION,
  };
}

// ── 표시용 라벨 ─────────────────────────────────────────────────
export function kindLabel(kind: RightKind): string {
  const m: Record<RightKind, string> = {
    geunjeodang: '근저당권', jeodang: '저당권', apryu: '압류', gaapryu: '가압류',
    dambo_gadeungi: '담보가등기', gyeongmae_gaesi: '경매개시결정등기', jeonse: '전세권',
    bowjeon_gadeungi: '소유권이전청구권가등기', imchagwon: '주택임차권', jisangwon: '지상권',
    jiyeokgwon: '지역권', hwanmae: '환매특약', gacheobun: '가처분',
    cheolgeo_gacheobun: '건물철거가처분', sintak: '신탁', soyugwon: '소유권', other: '기타',
  };
  return m[kind];
}
function won(n: number): string {
  return n.toLocaleString('ko-KR') + '원';
}
