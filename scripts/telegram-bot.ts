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
import { createTelegramClient } from './telegram-client.ts';
import { parseTelegramCommand } from './telegram-command.ts';

const TOKEN = process.env.AUCTION_BOT_TOKEN || process.env.GM_TELEGRAM_BOT_TOKEN || '';
const OWNER = String(process.env.AUCTION_CHAT_ID || process.env.GM_TELEGRAM_CHAT_ID || '');
const ALERT_CHAT = String(process.env.GM_TELEGRAM_CHAT_ID || '');
const ALLOWED_CHAT_IDS = new Set([OWNER, ALERT_CHAT].filter(Boolean));
const telegram = createTelegramClient(TOKEN);
const eok = (n: number | null | undefined): string => (n == null ? '-' : `${(n / 1e8).toFixed(1)}억`);
const RSLT: Record<string, string> = { '001': '매각', '002': '유찰' };

/** 인라인 키보드(선택) 포함 발송. */
async function send(chatId: string | number, text: string, keyboard?: unknown): Promise<void> {
  await telegram.sendMessage(chatId, text, keyboard);
}

/** 버튼 탭 응답(토스트) — 콜백은 반드시 answer해야 클라이언트 로딩 스피너가 멈춘다. */
async function answerCallback(id: string, text: string): Promise<void> {
  await telegram.answerCallbackQuery(id, text).catch((e) => console.error('answerCallback 실패:', e));
}

/** ★ 관심 토글 — 사건 단위(여러 물건이면 전체를 같은 상태로). */
async function toggleFav(caseNo: string): Promise<string> {
  const norm = caseNo.replace(/\s/g, '');
  const rows = await query<{ is_favorite: boolean; address: string }>(
    `update gm_listings
        set is_favorite = not coalesce((select bool_or(is_favorite) from gm_listings where case_no = $1), false)
      where case_no = $1
      returning is_favorite, address`,
    [norm],
  );
  if (!rows.length) return `수집된 매물에 없는 사건: ${norm}`;
  return rows[0]!.is_favorite
    ? `★ 관심 등록 — ${norm} · ${rows[0]!.address.slice(0, 22)} (변동 알림 대상)`
    : `☆ 관심 해제 — ${norm}`;
}

/** /case 응답용 인라인 버튼 — ★토글 콜백 + 대시보드 딥링크(DASHBOARD_URL 설정 시). */
function caseKeyboard(caseNo: string): unknown {
  const rows: unknown[] = [[{ text: '★ 관심 토글', callback_data: `fav|${caseNo}` }]];
  const base = process.env.DASHBOARD_URL;
  if (base) rows.push([{ text: '📊 대시보드에서 보기', url: `${base.replace(/\/+$/, '')}/#case=${encodeURIComponent(caseNo)}` }]);
  return { inline_keyboard: rows };
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

interface Reply { text: string; keyboard?: unknown }

async function handle(text: string): Promise<Reply> {
  const { name, arg } = parseTelegramCommand(text);
  switch (name) {
    case '/case': return arg
      ? { text: await cmdCase(arg), keyboard: caseKeyboard(arg.replace(/\s/g, '')) }
      : { text: '사용법: /case 2023타경111644' };
    case '/fav': case '/star': return { text: arg ? await toggleFav(arg) : '사용법: /fav 2023타경111644 (★ 토글)' };
    case '/digest': return { text: await runScript('digest') };
    case '/route': case '/임장': return { text: await runScript('route') };
    case '/status': return { text: await cmdStatus() };
    case '/update': {
      // 배포는 detached — 봇 자신이 재시작돼도 update.sh가 완료 알림을 보낸다.
      spawn('bash', ['deploy/update.sh'], { cwd: process.cwd(), detached: true, stdio: 'ignore' }).unref();
      return { text: '🚀 배포 시작 — pull→빌드→재시작. 완료 알림이 옵니다(봇 재시작으로 잠시 무응답 가능).' };
    }
    default: return {
      text: '경매 봇 명령:\n/case <사건번호> — 사건 실시간 조회(+★버튼)\n/fav <사건번호> — ★ 관심 토글\n/digest — 지금 추천\n/route — 이번 주 임장 코스\n/status — 크롤·건수 상태\n/update — 최신 코드 배포',
    };
  }
}

async function main(): Promise<void> {
  // 원샷 테스트: `npm run bot -- /status` — 루프 없이 명령 1회 실행 후 종료(검증용).
  const cli = process.argv.slice(2);
  if (cli.some((a) => a.startsWith('/'))) {
    console.log((await handle(cli.join(' '))).text);
    await pool().end();
    return;
  }
  if (!TOKEN) { console.error('AUCTION_BOT_TOKEN 필요'); process.exit(1); }
  if (!OWNER) { console.error('AUCTION_CHAT_ID 또는 GM_TELEGRAM_CHAT_ID 필요'); process.exit(1); }
  console.log(`[bot] 경매 봇 시작 — owner ${OWNER}`);
  let offset = 0;
  let skipPending = false;
  // 시작 시 밀린 업데이트 건너뛰기(중복 응답 방지). 텔레그램 일시 연결오류에도 죽지 않게 try/catch.
  try {
    const init = await telegram.getUpdates(-1);
    if (init.length) offset = init[init.length - 1]!.update_id + 1;
  } catch (e) {
    skipPending = true;
    offset = -1;
    console.error('[bot] init getUpdates 실패 — 복구 후 밀린 업데이트를 건너뜀:', e instanceof Error ? e.message : e);
  }

  // 짧은 폴링(3초 간격) — 30s 롱폴은 이 VM 네트워크에서 간헐 connect 실패. 짧은 연결(getMe급)은 안정적.
  for (;;) {
    try {
      const updates = await telegram.getUpdates(offset);
      if (skipPending) {
        offset = updates.length ? updates[updates.length - 1]!.update_id + 1 : 0;
        skipPending = false;
        console.log('[bot] Telegram 연결 복구 — 기존 업데이트 건너뜀');
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        // 인라인 버튼 콜백(★토글) — 소유자만
        const cq = u.callback_query;
        if (cq) {
          if (String(cq.from.id) !== OWNER) { await answerCallback(cq.id, '소유자 전용'); continue; }
          try {
            const [action, arg] = (cq.data ?? '').split('|');
            await answerCallback(cq.id, action === 'fav' && arg ? await toggleFav(arg) : '알 수 없는 버튼');
          } catch (e) {
            await answerCallback(cq.id, `오류: ${e instanceof Error ? e.message : e}`);
          }
          continue;
        }
        const m = u.message ?? u.channel_post;
        if (!m?.text) continue;
        if (!ALLOWED_CHAT_IDS.has(String(m.chat.id))) { await send(m.chat.id, '이 봇은 허용된 채널/소유자 전용입니다.'); continue; }
        try {
          const r = await handle(m.text);
          await send(m.chat.id, r.text, r.keyboard);
        } catch (e) { await send(m.chat.id, `오류: ${e instanceof Error ? e.message : e}`); }
      }
    } catch (e) {
      console.error('[bot] loop 오류:', e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

main().catch((e) => { console.error(e); pool().end(); process.exit(1); });
