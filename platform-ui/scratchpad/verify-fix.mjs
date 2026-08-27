import { chromium } from "playwright";
const B="http://127.0.0.1:3099";
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1440,height:1200}})).newPage();
await p.goto(`${B}/login`,{waitUntil:"domcontentloaded",timeout:60000}); await p.waitForTimeout(1500);
// demo mode: any email logs in
const e=p.locator('input[type="email"], input[name="email"]').first();
if(await e.count()){ await e.fill("demo-hansel@gaiada.com");
  const pw=p.locator('input[type="password"]').first(); if(await pw.count()) await pw.fill("x");
  await p.locator("button:has-text(\"Sign in\")").last().click(); await p.waitForTimeout(5000); }
console.log("after login:", p.url().replace(B,""));
await p.goto(`${B}/finance/receivables`,{waitUntil:"domcontentloaded",timeout:60000}); await p.waitForTimeout(4000);
const grid = await p.evaluate(()=>{
  const head=document.querySelector(".lux-table__head");
  if(!head) return null;
  const cs=getComputedStyle(head);
  const kids=[...head.children].map(k=>({t:k.textContent.trim().slice(0,10), top:Math.round(k.getBoundingClientRect().top)}));
  const tops=new Set(kids.map(k=>k.top));
  return { template: cs.gridTemplateColumns, tracks: cs.gridTemplateColumns.split(" ").filter(Boolean).length,
           headerCells: kids.length, distinctRowsOccupied: tops.size, labels: kids.map(k=>k.t) };
});
console.log(JSON.stringify(grid,null,2));
await p.screenshot({ path:"scratchpad/shot-FIXED-receivables.png" });
await b.close();
