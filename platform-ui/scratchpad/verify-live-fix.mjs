import { chromium } from "playwright";
const B="https://erp.gaiada.online", E=process.env.ERP_EMAIL, P=process.env.ERP_PASSWORD;
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1440,height:1200}})).newPage();
await p.goto(`${B}/login`,{waitUntil:"domcontentloaded",timeout:60000}); await p.waitForTimeout(1200);
const sso=p.locator('a[href*="/auth/login"]').first(); if(await sso.count()){await sso.click(); await p.waitForTimeout(2500);}
const u=p.locator('#username, input[name="username"]').first();
if(await u.count()){await u.fill(E); await p.locator('#password').first().fill(P);
  await p.locator('#kc-login').first().click(); await p.waitForTimeout(4500);}
for(const route of ["/finance/receivables","/finance/payables"]){
  await p.goto(`${B}${route}`,{waitUntil:"domcontentloaded",timeout:60000}); await p.waitForTimeout(3000);
  const r=await p.evaluate(()=>{
    const h=document.querySelector(".lux-table__head"); if(!h) return null;
    const cs=getComputedStyle(h); const kids=[...h.children];
    return { tracks: cs.gridTemplateColumns.split(" ").filter(Boolean).length,
             cells: kids.length,
             rowsOccupied: new Set(kids.map(k=>Math.round(k.getBoundingClientRect().top))).size,
             labels: kids.map(k=>k.textContent.trim()) };
  });
  console.log(route, JSON.stringify(r));
  await p.screenshot({ path:`scratchpad/shot-LIVE-FIXED${route.replace(/\//g,"_")}.png` });
}
await b.close();
