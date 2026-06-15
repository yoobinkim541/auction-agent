import 'dotenv/config'; import { chromium } from 'playwright';
const BASE='https://www.xn--b20bu5cuwtpue8ui.com';
async function main(){
  const b=await chromium.launch({headless:true});
  const ctx=await b.newContext({storageState:'.auth/deonakchal.json', userAgent:'gyeongmae-agent/0.1 (personal research; contact: owner)'});
  const page=await ctx.newPage();
  await page.goto(BASE+'/auction/view.html?product_id=1113138',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  await page.waitForTimeout(2500);
  const r=await page.evaluate(()=>({blocked:/비정상접속|접속을\s*차단/.test(document.documentElement.innerHTML), tables:document.querySelectorAll('table').length, len:document.body.innerText.length, logged:document.documentElement.innerHTML.includes('로그아웃')}));
  console.log(JSON.stringify(r));
  if(r.blocked) console.log('STILL_BLOCKED');
  else if(r.tables>0) console.log('OK_UNBLOCKED');
  else console.log('EMPTY_UNCLEAR');
  await b.close();
}
main().catch(e=>{console.error('ERR',e.message);process.exit(1)});
