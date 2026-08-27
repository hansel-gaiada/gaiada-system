import { chromium } from "playwright";
const BASE="https://erp.gaiada.online", E=process.env.ERP_EMAIL, P=process.env.ERP_PASSWORD;
const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1440,height:1200}}); const p=await ctx.newPage();
await p.goto(`${BASE}/login`,{waitUntil:"domcontentloaded",timeout:45000}); await p.waitForTimeout(1000);
const sso=p.locator('a[href*="/auth/login"]').first(); if(await sso.count()){await sso.click(); await p.waitForTimeout(2500);}
const u=p.locator('#username, input[name="username"]').first();
if(await u.count()){await u.fill(E); await p.locator('#password').first().fill(P);
  await p.locator('#kc-login, button[type="submit"]').first().click(); await p.waitForTimeout(4000);}
// What must be VISIBLE on each surface for the work to count as delivered.
const CHECKS=[
 ["/finance/receivables", ["Credit note","Write off","customer"]],
 ["/finance/payables",    ["vendor","bill"]],
 ["/finance/close",       ["Fiscal year","Reopen"]],
 ["/finance/treasury",    ["instrument"]],
 ["/finance/consolidation",["run"]],
];
for(const [route,needles] of CHECKS){
  await p.goto(`${BASE}${route}`,{waitUntil:"domcontentloaded",timeout:45000}); await p.waitForTimeout(2500);
  const t=(await p.locator("body").innerText().catch(()=>""))||"";
  const found=needles.filter(n=>new RegExp(n,"i").test(t));
  const miss=needles.filter(n=>!new RegExp(n,"i").test(t));
  console.log(`${route.padEnd(24)} found:[${found.join(", ")}] MISSING:[${miss.join(", ")}]`);
  const heads=(await p.locator("h1,h2,h3").allInnerTexts().catch(()=>[])).map(s=>s.trim()).filter(Boolean).slice(0,9);
  console.log(`   headings: ${heads.join(" | ")}`);
}
await b.close();
