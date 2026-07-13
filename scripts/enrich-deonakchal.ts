/**
 * 교차 보강 — courtauction 통과물건(점유관계 미상)을 deonakchal에서 사건번호로 찾아 임차인(대항력·확정일자·배당요구)
 *   주입 → 타겟 재분석. courtauction은 임차인 표를 못 파싱(명세서 PDF)해 명도판정이 부정확한 것을 보강한다.
 *
 * ⚠️ 계정 안전 최우선(과거 빠른 파싱으로 정지 이력):
 *   - 집 IP 프록시 필수 — egress가 집 IP 아니면(터널 꺼짐/데이터센터) 즉시 중단.
 *   - 엄격 직렬(한 번에 사건 하나, 병렬/다중 브라우저 금지) + 사건 간 8~20초 텀 + ~10건마다 1~2분 휴식.
 *   - 로그인 1회(세션 재사용). 차단 신호 시 즉시 중단 + 서킷브레이커.
 *   실행: CRAWL_PROXY=socks5://127.0.0.1:1080 npm run enrich:deonakchal -- --limit=30
 *   (밤샘 자동은 deploy/nightly-enrich.sh + gyeongmae-enrich.timer)
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { pool } from '../shared/db.ts';
import { fetchEnrichmentCandidates, upsertDeonakTenants } from '../shared/db.ts';
import { openLoggedInPage, lookupCaseDetail, recordBlock, SiteBlockedError, SessionExpiredError } from '../crawler/adapters/deonakchal.ts';
import { crawlFetch } from '../crawler/proxy.ts';

const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.round(ms)));

/** egress가 집 IP(≠ VM 직접, 터널 경유)인지 검증. 프록시 미설정/터널 다운이면 false. */
async function verifyHomeEgress(): Promise<boolean> {
  if (!process.env.CRAWL_PROXY) { console.error('[enrich] ⛔ CRAWL_PROXY 미설정 — 집 IP 프록시 필수. 중단.'); return false; }
  try {
    const egress = (await (await crawlFetch('https://api.ipify.org', {})).text()).trim();
    const direct = (await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8000) })).text()).trim();
    if (!egress || egress === direct) {
      console.error(`[enrich] ⛔ egress(${egress || '실패'})가 VM 직접(${direct})과 동일 = 터널 미동작. 중단.`);
      return false;
    }
    console.log(`[enrich] ✅ egress=집 IP(${egress}), VM직접(${direct}) — 안전.`);
    return true;
  } catch (e) { console.error('[enrich] ⛔ egress 검증 실패 — 중단:', e instanceof Error ? e.message : e); return false; }
}

async function main(): Promise<void> {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = Math.max(1, Math.min(200, limitArg ? parseInt(limitArg.split('=')[1] ?? '', 10) || 30 : 30));

  if (!(await verifyHomeEgress())) { await pool().end(); process.exitCode = 1; return; }

  const candidates = await fetchEnrichmentCandidates(limit);
  console.log(`[enrich] 보강 후보 ${candidates.length}건 (통과+courtauction+점유미상, ★관심·고점수 우선)`);
  if (!candidates.length) { await pool().end(); return; }

  const session = await openLoggedInPage(); // 쿨다운 중이면 null
  if (!session) { await pool().end(); return; }
  const { page, close } = session;

  const enrichedIds: number[] = [];
  let found = 0, noTenant = 0, missed = 0, blocked = false;
  try {
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      try {
        const res = await lookupCaseDetail(page, c.court, c.case_no, c.item_no); // 엄격 직렬: 한 건씩 순차
        if (!res) {
          await upsertDeonakTenants(c.id, c.case_no, [], false); // deonakchal에 없음 — 나중에 재시도(retryDays 후)
          missed++;
          console.log(`[enrich] · ${c.case_no} (${c.court}) — deonakchal 미발견`);
        } else if (res.detail.tenants.length) {
          await upsertDeonakTenants(c.id, c.case_no, res.detail.tenants, true);
          enrichedIds.push(c.id);
          found++;
          console.log(`[enrich] ✓ ${c.case_no} (${c.court}) 임차인 ${res.detail.tenants.length}명 보강 (product ${res.productId})`);
        } else {
          await upsertDeonakTenants(c.id, c.case_no, [], true); // 찾았으나 임차인 없음(소유자점유/공실) — 재시도 불필요
          noTenant++;
          console.log(`[enrich] ○ ${c.case_no} (${c.court}) — 찾음, 임차인 없음(소유자점유/공실)`);
        }
      } catch (e) {
        if (e instanceof SiteBlockedError) {
          recordBlock('enrich: 차단 감지');
          console.error('[enrich] ⛔ 차단 감지 — 즉시 중단 + 쿨다운 기록.');
          blocked = true;
          break;
        }
        if (e instanceof SessionExpiredError) {
          // 재로그인 재시도까지 실패한 지속적 세션 문제 — 남은 건을 계속 두드리지 말고 중단(계정 보호). 쿨다운은 걸지 않음.
          console.error('[enrich] ⛔ 세션 만료 지속(재로그인 실패) — 배치 중단.');
          blocked = true;
          break;
        }
        console.warn(`[enrich] ${c.case_no} 조회 실패(스킵):`, e instanceof Error ? e.message : e);
      }
      // 인간형 페이싱: 사건 간 8~20초 텀 + ~10건마다 1~2분 휴식(마지막 건 뒤엔 생략)
      if (i < candidates.length - 1) {
        if ((i + 1) % 10 === 0) { const r = rnd(60_000, 120_000); console.log(`[enrich] ☕ 휴식 ${Math.round(r / 1000)}s...`); await wait(r); }
        else await wait(rnd(8_000, 20_000));
      }
    }
  } finally {
    await close();
  }

  console.log(`[enrich] 완료 — 임차인보강 ${found} · 임차인없음 ${noTenant} · 미발견 ${missed}${blocked ? ' · 차단중단' : ''}`);

  // 보강분만 타겟 재분석(임차인 반영 → 명도판정·인수보증금·안전마진 갱신)
  if (enrichedIds.length) {
    console.log(`[enrich] 타겟 재분석 ${enrichedIds.length}건 …`);
    await pool().end(); // 재분석은 별도 프로세스(자체 pool)
    const rc = spawnSync('npm', ['run', 'analyze', '--', `--ids=${enrichedIds.join(',')}`], { stdio: 'inherit' });
    process.exitCode = rc.status ?? 0;
    return;
  }
  await pool().end();
}

main().catch((e) => { console.error('[enrich] 실패:', e); process.exitCode = 1; });
