import { test as base, expect } from "@playwright/test";

/**
 * `test` with a `page.goto` that also waits for React's streaming to settle. DW-9d-1.
 *
 * Under the default workspace shell a page streams: for ~150 ms after the `load` event the finished content sits
 * twice in the DOM, once in place and once as React's hidden streaming copy (`div#S:n[hidden]`), until React
 * moves it. A strict locator (`getByTestId(...)`, `getByText(...)`) that runs in that window throws "strict mode
 * violation ... resolved to 2 elements", and `expect(...).toBeVisible()` does not retry that error. The workspace
 * shell is the only layout (DW-D38), so every page under it streams this way. Specs whose pages stream import `test`
 * from here instead of "@playwright/test"; nothing else changes.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const settle = async () => {
      // A navigation that ends in a redirect or a non-HTML body has nothing to wait for; never fail the call itself.
      await page.waitForFunction(() => !document.querySelector('div[hidden][id^="S:"]'), undefined, { timeout: 5_000 }).catch(() => {});
    };
    const goto = page.goto.bind(page);
    page.goto = (async (url: string, options?: Parameters<typeof goto>[1]) => {
      const response = await goto(url, options);
      await settle();
      return response;
    }) as typeof page.goto;
    const reload = page.reload.bind(page);
    page.reload = (async (options?: Parameters<typeof reload>[0]) => {
      const response = await reload(options);
      await settle();
      return response;
    }) as typeof page.reload;
    await use(page);
  },
});
export { expect };
