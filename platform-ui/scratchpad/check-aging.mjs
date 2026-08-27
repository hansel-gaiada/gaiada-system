import { chromium } from "playwright";
const BASE="https://erp.gaiada.online", E=process.env.ERP_EMAIL, P=process.env.ERP_PASSWORD;
const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1440,height:1200}}); const p=await ctx.newPage();
await p.goto(`${BASE}/login`,{waitUntil:"domcontentloaded"}); await p.waitForTimeout(1000);
const sso=p.locator('a[href*="/auth/login"]').first(); if(await sso.count()){await sso.click(); await p.waitForTimeout(2500);}
const u=p.locator('#username, input[name="username"]').first();
if(await u.count()){await u.fill(E); await p.locator('#password').first().fill(P);
  await p.locator('#kc-login').first().click(); await p.waitForTimeout(4000);}
await p.goto(`${BASE}/finance/receivables`,{waitUntil:"domcontentloaded"}); await p.waitForTimeout(2500);
const tbl=p.locator("table").first();
console.log("tables on page:", await p.locator("table").count());
const ths=await tbl.locator("th").allInnerTexts();
console.log("header cells (", ths.length, "):", ths.map(s=>s.replace(/\s+/g," ").trim()));
const firstRow=await tbl.locator("tbody tr").first().locator("td").allInnerTexts();
console.log("first row cells (", firstRow.length, "):", firstRow.map(s=>s.replace(/\s+/g," ").trim()));
// Is the table wider than its container (i.e. actually overflowing)?
const box=await tbl.boundingBox(); const par=await tbl.locator("xpath=..").boundingBox();
console.log("table w:", box?.width, "| container w:", par?.width, "| overflowing:", (box?.width||0) > (par?.width||0)+1);
// Do header cells wrap onto multiple visual lines?
for(const th of (await tbl.locator("th").all()).slice(0,8)){
  const t=(await th.innerText()).replace(/\s+/g," ").trim(); const bb=await th.boundingBox();
  console.log(`   th "${t}" h=${bb?.height}`);
}
await b.close();
