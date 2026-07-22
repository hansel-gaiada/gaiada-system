const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('CONSOLE:', msg.text()));
  page.on('pageerror', err => console.log('PAGEERROR:', err.message));
  await page.goto('http://localhost:3099/login');
  await page.getByLabel('Email').fill('hansel@gaiada.com');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(5000);
  console.log('URL:', page.url());
  console.log('BODY:', (await page.content()).slice(0, 2000));
  await browser.close();
})();
