import { chromium } from "playwright";
const B="https://erp.gaiada.online", E=process.env.ERP_EMAIL, P=process.env.ERP_PASSWORD;
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1440,height:1200}})).newPage();
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,200)));
await p.goto(`${B}/login`,{waitUntil:"domcontentloaded",timeout:60000}); await p.waitForTimeout(1200);
const sso=p.locator('a[href*="/auth/login"]').first(); if(await sso.count()){await sso.click(); await p.waitForTimeout(2500);}
const u=p.locator('#username, input[name="username"]').first();
if(await u.count()){await u.fill(E); await p.locator('#password').first().fill(P);
  await p.locator('#kc-login').first().click(); await p.waitForTimeout(4500);}
for(const r of ["/systems/automation","/hr/settings","/hr/leave","/me/pay"]){
  errs.length=0;
  await p.goto(`${B}${r}`,{waitUntil:"domcontentloaded",timeout:60000}); await p.waitForTimeout(2800);
  const d=await p.evaluate(()=>[...document.querySelectorAll(".lux-table__head")].map(h=>{
    const kids=[...h.children];
    return { template:getComputedStyle(h).gridTemplateColumns,
      cells:kids.map(k=>({t:k.textContent.trim().slice(0,14), top:Math.round(k.getBoundingClientRect().top),
                          h:Math.round(k.getBoundingClientRect().height), w:Math.round(k.getBoundingClientRect().width)})) };
  }));
  console.log("\n####",r, errs.length?`PAGEERROR: ${errs[0]}`:"");
  d.forEach((t,i)=>{ const tops=new Set(t.cells.map(c=>c.top));
    if(tops.size>1) console.log(`  table${i} tops=${[...tops].join(",")} cells=`, JSON.stringify(t.cells)); });
  await p.screenshot({path:`scratchpad/shot-AUDIT${r.replace(/\//g,"_")}.png`});
}
await b.close();
