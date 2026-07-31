import { chromium, devices } from "@playwright/test";
const OUT = "/private/tmp/claude-501/-Users-firmansyah-Development-GAIADA-gaiada-system/678a3a8f-02a2-43bf-91b0-cf65085a2421/scratchpad";
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices["iPhone 13"] });
const p = await ctx.newPage();
await p.goto("http://localhost:3005/login");
await p.getByLabel("Email").fill("hansel@gaiada.com");
await p.getByRole("button", { name: /sign in/i }).click();
await p.waitForURL("**/");
await ctx.addCookies([{ name: "gaiada_tenant", url: "http://localhost:3005", value: "co-agency" }]);
await p.goto("http://localhost:3005/projects");
await p.waitForTimeout(2500);

const closed = await p.evaluate(() => {
  const s = document.querySelector(".erp-side").getBoundingClientRect();
  return { sidebarLeft: Math.round(s.left), mainLeft: Math.round(document.querySelector(".erp-main").getBoundingClientRect().left), docW: document.documentElement.scrollWidth };
});
console.log("CLOSED:", JSON.stringify(closed));
await p.screenshot({ path: `${OUT}/m2-closed.png` });

// Open the drawer through the real control.
await p.getByRole("button", { name: /open navigation/i }).click();
await p.waitForTimeout(700);
const open = await p.evaluate(() => {
  const s = document.querySelector(".erp-side").getBoundingClientRect();
  return { sidebarLeft: Math.round(s.left), width: Math.round(s.width), scrim: !!document.querySelector(".erp-scrim"),
           navAttr: document.documentElement.getAttribute("data-nav"),
           focused: document.activeElement?.textContent?.trim().slice(0, 20) };
});
console.log("OPEN:", JSON.stringify(open));
await p.screenshot({ path: `${OUT}/m2-open.png` });

// Escape must close it.
await p.keyboard.press("Escape");
await p.waitForTimeout(500);
console.log("AFTER ESC data-nav:", await p.evaluate(() => document.documentElement.getAttribute("data-nav")));

// Tap-target census after the fix.
const small = await p.evaluate(() => [...document.querySelectorAll("a,button,select,input")]
  .map(el => { const r = el.getBoundingClientRect(); return { t: (el.textContent||el.tagName).trim().slice(0,18), h: Math.round(r.height) }; })
  .filter(x => x.h > 0 && x.h < 40));
console.log(`tap targets <40px: ${small.length}`, small.slice(0,6).map(s=>`"${s.t}"(${s.h})`).join(" "));
await b.close();
