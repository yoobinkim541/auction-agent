/**
 * 더낙찰옥션 차단/세션 상태 진단 스크립트.
 * 사용: npx tsx scripts/blockcheck.ts
 * 출력 의미:
 *   OK_UNBLOCKED       — 정상 로그인·경매 페이지 로드 성공 (IP 차단 아님)
 *   STILL_BLOCKED      — BLOCK_RE 텍스트(차단안내) 감지
 *   SESSION_INVALID    — 로그인 폼으로 리다이렉트(IP 차단 또는 세션 만료·인증실패)
 *                        .auth/deonakchal.json 을 갱신하거나 프록시를 붙여 재시도
 *   EMPTY_UNCLEAR      — 페이지 로드 실패 또는 판단 불가(네트워크 오류 등)
 *
 * 더낙찰옥션 IP 차단 동작: 차단 안내 없이 로그인 폼으로 조용히 리다이렉트.
 * → '로그아웃' 링크 없으면 SESSION_INVALID 로 출력(차단 vs 세션 만료는 동일 증상).
 */
import 'dotenv/config';
import { chromium } from 'playwright';

const BASE = 'https://www.xn--b20bu5cuwtpue8ui.com';
const PROBE_ID = '1113138'; // 알려진 매물 ID (페이지 구조 변경 추적용)

async function main() {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({
    storageState: '.auth/deonakchal.json',
    userAgent: 'gyeongmae-agent/0.1 (personal research; contact: owner)',
  });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/auction/view.html?product_id=${PROBE_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  }).catch(() => {});
  await page.waitForTimeout(2500);

  const r = await page.evaluate(() => ({
    blocked: /비정상접속|접속을\s*차단/.test(document.documentElement.innerHTML),
    tables: document.querySelectorAll('table').length,
    len: document.body.innerText.length,
    logged: document.documentElement.innerHTML.includes('로그아웃'),
    // 로그인 폼 특징: 로그인 버튼 또는 아이디 input이 있음
    loginForm: document.documentElement.innerHTML.includes('아이디') && !document.documentElement.innerHTML.includes('로그아웃'),
  }));

  console.log(JSON.stringify(r));

  if (r.blocked) {
    console.log('STILL_BLOCKED');
  } else if (r.logged && r.tables >= 3) {
    console.log('OK_UNBLOCKED');
  } else if (r.loginForm || (!r.logged && r.tables <= 5)) {
    // 로그인 폼으로 리다이렉트됨 → IP 차단 또는 세션 만료(양쪽 동일 증상)
    console.log('SESSION_INVALID');
    console.log('  → .auth/deonakchal.json 갱신(CRAWL_HEADLESS=false 로 재로그인) 또는 SOCKS5 프록시 설정 후 재시도');
  } else {
    console.log('EMPTY_UNCLEAR');
  }

  await b.close();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
