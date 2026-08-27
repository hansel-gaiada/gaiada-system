import { chromium } from "playwright";
const B="https://erp.gaiada.online", E=process.env.ERP_EMAIL, P=process.env.ERP_PASSWORD;
// Every non-finance route the 62-table scan implicated (finance already verified on live).
const ROUTES=["/hr/attendance","/hr/cases","/hr/compensation","/hr/compliance","/hr/leave",
"/hr/payroll","/hr/recruitment","/hr/reviews","/hr/settings","/it/devices",
"/learning/authoring","/learning/catalogue","/learning/compliance","/me/pay",
"/meetings","/monitoring","/monitoring/channels","/systems/automation"];
const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1440,height:1200}}); const p=await ctx.newPage();
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,120)));
await p.goto(`${B}/login`,{waitUntil:"domcontentloaded",timeout:60000}); await p.waitForTimeout(1200);
const sso=p.locator('a[href*="/auth/login"]').first(); if(await sso.count()){await sso.click(); await p.waitForTimeout(2500);}
const u=p.locator('#username, input[name="username"]').first();
if(await u.count()){await u.fill(E); await p.locator('#password').first().fill(P);
  await p.locator('#kc-login').first().click(); await p.waitForTimeout(4500);}
if(/\/login|\/realms\//.test(p.url())){console.error("LOGIN FAILED — stopping"); process.exit(1);}
let bad=0, tablesSeen=0, pagesWithTables=0;
for(const r of ROUTES){
  errs.length=0;
  const resp=await p.goto(`${B}${r}`,{waitUntil:"domcontentloaded",timeout:60000}).catch(()=>null);
  await p.waitForTimeout(2500);
  const bounced=/\/login/.test(p.url());
  const res=await p.evaluate(()=>{
    const out=[];
    for(const h of document.querySelectorAll(".lux-table__head")){
      const cs=getComputedStyle(h); const kids=[...h.children];
      out.push({ tracks: cs.gridTemplateColumns.split(" ").filter(Boolean).length,
                 cells: kids.length,
                 rows: new Set(kids.map(k=>Math.round(k.getBoundingClientRect().top))).size });
    }
    return out;
  }).catch(()=>[]);
  tablesSeen+=res.length; if(res.length) pagesWithTables++;
  const wrapped=res.filter(t=>t.rows>1 || t.tracks!==t.cells);
  if(wrapped.length) bad++;
  const st=resp?.status()??0;
  console.log(`${String(st).padEnd(4)} ${r.padEnd(24)} tables:${String(res.length).padStart(2)} ${wrapped.length?`WRAPPED x${wrapped.length} ${JSON.stringify(wrapped[0])}`:"ok"}${bounced?" BOUNCED-TO-LOGIN":""}${errs.length?" pageerror":""}`);
}
console.log(`\n${pagesWithTables} page(s) had tables · ${tablesSeen} table(s) measured · ${bad} page(s) with a wrapped table`);
await b.close();
