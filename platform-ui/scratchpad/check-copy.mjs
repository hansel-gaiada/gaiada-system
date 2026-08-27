import { chromium } from "playwright";
const BASE="https://erp.gaiada.online", E=process.env.ERP_EMAIL, P=process.env.ERP_PASSWORD;
const b=await chromium.launch(); const p=await (await b.newContext()).newPage();
await p.goto(`${BASE}/login`,{waitUntil:"domcontentloaded",timeout:45000}); await p.waitForTimeout(1000);
const sso=p.locator('a[href*="/auth/login"]').first(); if(await sso.count()){await sso.click(); await p.waitForTimeout(2500);}
const u=p.locator('#username, input[name="username"]').first();
if(await u.count()){await u.fill(E); await p.locator('#password').first().fill(P);
  await p.locator('#kc-login, button[type="submit"]').first().click(); await p.waitForTimeout(4000);}
for(const r of ["/finance/receivables","/finance/payables","/finance/consolidation","/finance/treasury"]){
  await p.goto(`${BASE}${r}`,{waitUntil:"domcontentloaded",timeout:45000}); await p.waitForTimeout(2200);
  const t=(await p.locator("body").innerText())||"";
  console.log("\n########", r);
  console.log((await p.locator("h1,h2,h3").allInnerTexts()).map(s=>s.replace(/\s+/g," ").trim()).filter(Boolean).join(" | "));
  const i=t.search(/not built|still not built|What is built here/i);
  if(i>=0) console.log("COPY>>", t.slice(i, i+420).replace(/\s+/g," "));
}
await b.close();
