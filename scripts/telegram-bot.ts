/**
 * 경매 봇(양방향) — 텔레그램 longpoll 데몬. 소유자(AUCTION_CHAT_ID)의 명령만 처리.
 *   /case <사건번호>  — 경매사건검색(pgj15A) 실시간 조회 + 우리 분석(점수·마진)
 *   /digest           — 지금 다이제스트
 *   /status           — 크롤·수집·건수 헬스
 *   /help             — 도움말
 * 실행: npm run bot  (systemd gyeongmae-bot.service 로 상시). CRAWL_PROXY 비활성=직접.
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { query, pool } from '../shared/db.ts';
import { collectCaseResults, courtCodeByName, type SaleResultRound } from '../crawler/adapters/courtauction.ts';

const TOKEN = process.env.AUCTION_BOT_TOKEN || process.env.GM_TELEGRAM_BOT_TOKEN || '';
const OWNER = String(process.env.AUCTION_CHAT_ID || process.env.GM_TELEGRAM_CHAT_ID || '5771238245');
const API = `https://api.telegram.org/bot${TOKEN}`;
const eok = (n: number | null | undefined): string => (n == null ? '-' : `${(n / 1e8).toFixed(1)}억`);
const RSLT: Record<string, string> = { '001': '매각', '002': '유찰' };

async function send(chatId: string | number, text: string): Promise<void> {
  await fetch(`${API}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }),
  }).catch((e) => console.error('send 실패:', e));
}

/** npm run <script> stdout 캡처(디제스트 재사용). */
function runScript(npmScript: string): Promise<string> {
  return new Promise((resolve) => {
    const cp = spawn('npm', ['run', '--silent', npmScript], { cwd: process.cwd() });
    let out = '';
    cp.stdout.on('data', (d) => (out += d));
    cp.on('close', () => resolve(out.trim() || '(출력 없음)'));
    cp.on('error', (e) => resolve(`실행 실패: ${e.message}`));
  });
}

async function cmdCase(caseNo: string): Promise<string> {
  const norm = caseNo.replace(/\s/g, '');
  const mine = await query<{ court: string; item_no: string; property_type: string; address: string; appraisal_value: number | null; min_bid_price: number | null; total_score: number | null; sm: number | null }>(
    `select l.court, coalesce(l.item_no,'1') item_no, l.property_type, l.address,
            l.appraisal_value::float8, l.min_bid_price::float8, s.total_score::int,
            (loc.acquisition_cost->>'trueSafetyMargin')::float8 sm
       from gm_listings l left join gm_scores s on s.listing_id=l.id
       left join gm_location_analysis loc on loc.listing_id=l.id
      where l.case_no=$1 limit 1`, [norm]);
  const row = mine[0];
  const court = row?.court ?? '서울중앙지방법원';
  const cortOfcCd = courtCodeByName(court);
  if (!cortOfcCd) return `조회 불가: '${court}'는 지원 법원 코드가 없습니다. (수도권만)`;

  const map = await collectCaseResults([{ caseNo: norm, cortOfcCd, itemNo: row?.item_no ?? '1' }]);
  const rounds: SaleResultRound[] = map.get(`${norm}|${row?.item_no ?? '1'}`) ?? [];

  const lines = [`🏛 ${norm} · ${court}`];
  if (row) lines.push(`${row.property_type} · ${row.address.slice(0, 30)}\n감정 ${eok(row.appraisal_value)} / 최저 ${eok(row.min_bid_price)} · 우리점수 ⭐${row.total_score ?? '-'}${row.sm != null ? ` · 진짜마진 ${Math.round(row.sm * 100)}%` : ''}`);
  if (!rounds.length) { lines.push('기일결과: (조회 결과 없음 — 종결/미공개)'); return lines.join('\n'); }
  lines.push('기일내역:');
  for (const rd of rounds) {
    const r = rd.resultCd ? (RSLT[rd.resultCd] ?? rd.resultCd) : '예정';
    lines.push(`  ${rd.date} ${rd.kindCd === '02' ? '(결정)' : ''} ${r}${rd.sold ? ` · 낙찰 ${eok(rd.soldAmount)}` : ''}`);
  }
  return lines.join('\n');
}

async function cmdStatus(): Promise<string> {
  const h = await query<{ last: string | null; age: number | null }>(`select max(started_at)::date::text last, (current_date - max(started_at)::date) age from gm_crawl_runs where n_found>0`);
  const c = await query<{ total: number; passed: number; results: number }>(`select (select count(*) from gm_listings)::int total, (select count(*) from gm_scores where passed_filter)::int passed, (select count(*) from gm_auction_results)::int results`);
  const lastRun = await query<{ source: string; status: string; n: number; t: string }>(`select source, status, n_found n, started_at::timestamptz(0)::text t from gm_crawl_runs order by started_at desc limit 3`);
  const age = h[0]?.age;
  const out = [`📊 경매 봇 상태`, `마지막 실수집: ${h[0]?.last ?? '없음'}${age != null ? ` (${age}일 전${age >= 2 ? ' ⚠️' : ''})` : ''}`, `매물 ${c[0]?.total ?? 0} · 통과 ${c[0]?.passed ?? 0} · 결과 ${c[0]?.results ?? 0}`, '최근 크롤:'];
  for (const r of lastRun) out.push(`  ${r.t} ${r.source} ${r.status} n=${r.n}`);
  return out.join('\n');
}

async function handle(text: string): Promise<string> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch ((cmd ?? '').toLowerCase()) {
    case '/case': return arg ? cmdCase(arg) : '사용법: /case 2023타경111644';
    case '/digest': return runScript('digest');
    case '/status': return cmdStatus();
    default: return '경매 봇 명령:\n/case <사건번호> — 사건 실시간 조회\n/digest — 지금 추천\n/status — 크롤·건수 상태';
  }
}

async function main(): Promise<void> {
  // 원샷 테스트: `npm run bot -- /status` — 루프 없이 명령 1회 실행 후 종료(검증용).
  const cli = process.argv.slice(2);
  if (cli.some((a) => a.startsWith('/'))) {
    console.log(await handle(cli.join(' ')));
    await pool().end();
    return;
  }
  if (!TOKEN) { console.error('AUCTION_BOT_TOKEN 필요'); process.exit(1); }
  console.log(`[bot] 경매 봇 시작 — owner ${OWNER}`);
  let offset = 0;
  // 시작 시 밀린 업데이트 건너뛰기(중복 응답 방지)
  const init = await (await fetch(`${API}/getUpdates?offset=-1`)).json().catch(() => null) as { result?: { update_id: number }[] } | null;
  if (init?.result?.length) offset = init.result[init.result.length - 1]!.update_id + 1;

  for (;;) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
      const j = await res.json() as { ok: boolean; result?: { update_id: number; message?: { chat: { id: number }; text?: string } }[] };
      for (const u of j.result ?? []) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m?.text) continue;
        if (String(m.chat.id) !== OWNER) { await send(m.chat.id, '이 봇은 소유자 전용입니다.'); continue; }
        try { await send(m.chat.id, await handle(m.text)); }
        catch (e) { await send(m.chat.id, `오류: ${e instanceof Error ? e.message : e}`); }
      }
    } catch (e) {
      console.error('[bot] loop 오류:', e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((e) => { console.error(e); pool().end(); process.exit(1); });
