import { expect } from "@playwright/test";
import { test as base } from "./settledPage";
import { classicLayoutCookie } from "./appCookies";

/**
 * `test` for a person who CHOSE the classic layout. DW-9d-1.
 *
 * The workspace shell is the default now, so a test that drives a classic-shell element (the classic sidebar and its
 * rows, the classic top bar's search and bell, the floating assistant button, the rail and its flyouts) plants the
 * `gaiada_prefs` choice first. Classic until DW-9d-2 removes it; these tests go with it.
 */
export const classicTest = base.extend({
  page: async ({ page, context, baseURL }, use) => {
    await context.addCookies([classicLayoutCookie(baseURL ?? "http://localhost")]);
    await use(page);
  },
});
export { expect };
