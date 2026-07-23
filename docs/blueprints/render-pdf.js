const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/Hansel/Documents/Hansel/Projects/gaiada-system/gaiada-system/platform-ui/node_modules/playwright');

const mermaidJs = fs.readFileSync(path.resolve('node_modules/mermaid/dist/mermaid.min.js'), 'utf8');

const files = [
  { in: 'webdesk-blueprint.html', out: 'GAIADA-WebDesk-Engineering-Blueprint.pdf', foot: 'GAIADA WebDesk — Engineering Blueprint' },
  { in: 'gaiada-blueprint.html',  out: 'Gaiada-AI-Platform-System-Blueprint.pdf', foot: 'Gaiada AI Platform — System Blueprint' },
];

// Reproduce the artifact LIGHT theme in print (not the ink-saver theme) + page-fit diagrams + a contents page.
const themeCss = `
  *{ -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
  html,body{ background:var(--paper) !important; }
  .themehint{ display:none !important; }
  .plate{ overflow:visible !important; box-shadow:none !important; background:var(--plate) !important; border:1px solid var(--plate-line) !important; }
  .plate .mermaid{ min-width:0 !important; display:block !important; }
  .mermaid svg{ max-width:100% !important; max-height:216mm !important; width:auto !important; height:auto !important; display:block; margin:0 auto; }
  figure,.spec,.tablewrap,.phase,.card,.note,.titleblock{ break-inside:avoid; }
  .spec-head,tr,.part-head{ break-inside:avoid; }
  h2,h3,h4{ break-after:avoid; }
  .part{ break-before:page; }
  .part:first-of-type{ break-before:page; }
  .cover{ break-after:page; }
  .spec,.card,.tablewrap{ box-shadow:none !important; }

  /* contents page */
  .contents-page{ break-after:page; padding-top:.4rem; }
  .contents-title{ font-family:var(--serif); font-weight:600; font-size:2rem; color:var(--ink);
    margin:0 0 1.3rem; border-bottom:2px solid var(--ink); padding-bottom:.5rem; }
  .contents-list{ list-style:none; margin:0; padding:0; }
  .contents-list li{ display:flex; gap:1rem; align-items:baseline; padding:.5rem .2rem;
    border-bottom:1px solid var(--line); font-size:1.02rem; }
  .contents-list .cn{ font-family:var(--mono); color:var(--accent); font-weight:600; min-width:2.4em; }
  .contents-note{ font-family:var(--mono); font-size:.72rem; color:var(--ink-faint); margin-top:1.3rem; letter-spacing:.02em; }
`;

const footer = (title) => `
  <div style="width:100%; font-family:'Consolas','Courier New',monospace; font-size:8px; color:#4B574F;
       padding:0 12mm; display:flex; justify-content:space-between; align-items:center;">
    <span style="color:#1E5E44; letter-spacing:.04em;">GAIADA · ${title}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;

(async () => {
  const browser = await chromium.launch();
  for (const f of files) {
    const page = await browser.newPage();
    const url = 'file:///' + path.resolve(f.in).replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.addScriptTag({ content: mermaidJs });
    await page.addStyleTag({ content: themeCss });

    // Build a contents page from the TOC and insert it after the cover.
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('.toc a')].map(a => {
        const n = a.querySelector('.n')?.textContent.trim() || '';
        const t = a.textContent.replace(n, '').trim();
        return { n, t };
      });
      const lis = items.map(i => `<li><span class="cn">${i.n}</span><span>${i.t}</span></li>`).join('');
      const html = `<section class="contents-page">
        <h2 class="contents-title">Contents</h2>
        <ol class="contents-list">${lis}</ol>
        <p class="contents-note">Sections are numbered; each begins on a new page. Use the PDF bookmarks or the page footer to navigate.</p>
      </section>`;
      document.querySelector('.cover').insertAdjacentHTML('afterend', html);
    });

    const n = await page.evaluate(async () => {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', htmlLabels: true,
        flowchart: { useMaxWidth: false, htmlLabels: true },
        sequence: { useMaxWidth: false }, er: { useMaxWidth: false }, gantt: { useMaxWidth: false } });
      await window.mermaid.run({ querySelector: '.mermaid' });
      return document.querySelectorAll('.mermaid svg').length;
    });

    await page.emulateMedia({ media: 'print', colorScheme: 'light' });
    await page.waitForTimeout(400);

    const opts = {
      path: f.out, format: 'A4', printBackground: true,
      displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: footer(f.foot),
      margin: { top: '13mm', bottom: '16mm', left: '12mm', right: '12mm' },
      preferCSSPageSize: false,
    };
    try { await page.pdf({ ...opts, outline: true, tagged: true }); }
    catch (e) { console.log('  (outline/tagged unsupported, plain pdf):', e.message); await page.pdf(opts); }

    const kb = Math.round(fs.statSync(f.out).size / 1024);
    console.log(`wrote ${f.out}  (${n} diagrams, ${kb} KB)`);
    await page.close();
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
