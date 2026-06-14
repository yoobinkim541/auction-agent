/** 저장된 세션으로 /auction/list.html 결과 페이지를 덤프해 매물 행 구조를 본다. */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'https://www.xn--b20bu5cuwtpue8ui.com';
const STORAGE = '.auth/deonakchal.json';

async function main() {
  const url = BASE + (process.argv[2] ?? '/auction/list.html');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: fs.existsSync(STORAGE) ? STORAGE : undefined });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(2000);
  const html = await page.content();
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync('tmp/list.html', html);
  const cases = (html.match(/[0-9]{4}타경[0-9]+/g) ?? []).length;
  console.log(`URL: ${url}`);
  console.log(`저장: tmp/list.html (${html.length} bytes)`);
  console.log(`사건번호(타경) 개수: ${cases}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
