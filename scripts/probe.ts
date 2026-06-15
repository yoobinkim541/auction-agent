/** 주어진 결과 URL의 물건종류/진행여부 분포를 출력. 사용: tsx scripts/probe.ts "<path>" */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'https://www.xn--b20bu5cuwtpue8ui.com';
const STORAGE = '.auth/deonakchal.json';
const TERMINAL = /(배당종결|취하|기각|각하|낙찰|대금납부|배당완료|취소)/;

async function main() {
  const path = process.argv[2] ?? '/auction/list.html?sido1=11&yongdo=02&page=1';
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: fs.existsSync(STORAGE) ? STORAGE : undefined });
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1500);
  const rows = page.locator('table.tbl_act_list_wins tr[id^="tr_"]');
  const n = await rows.count();
  const types: Record<string, number> = {};
  let active = 0, terminal = 0, future = 0;
  for (let i = 0; i < n; i++) {
    const t = (await rows.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ');
    const tm = t.match(/\[([가-힣()]+)\]/);
    if (tm) types[tm[1]!] = (types[tm[1]!] ?? 0) + 1;
    const st = t.match(/(신건|유찰|진행|배당종결|취하|기각|각하|낙찰|변경|재진행|재매각|미진행|대금납부)\s*\(/);
    if (st) (TERMINAL.test(st[1]!) ? terminal++ : active++);
    if (/202[6-9]-\d\d-\d\d/.test(t)) future++;
  }
  console.log(`${path}\n  행:${n} 진행:${active} 종결:${terminal} 미래기일:${future} 종류:${JSON.stringify(types, null, 0)}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
