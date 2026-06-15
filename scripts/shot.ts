import { chromium } from 'playwright';
async function main(){
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
  const p = await ctx.newPage();
  await p.goto('http://localhost:5174/', { waitUntil: 'networkidle', timeout: 30000 }).catch(()=>{});
  await p.waitForTimeout(2500);
  await p.screenshot({ path: '/tmp/m_tabbar.png' });
  console.log('tabbar buttons:', await p.$$eval('.tabbar button', e=>e.length).catch(()=>0));
  await b.close();
}
main().catch(e=>{console.error('ERR',e.message);process.exit(1)});
