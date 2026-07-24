const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/Hansel/Documents/Hansel/Projects/gaiada-system/gaiada-system/platform-ui/node_modules/playwright');

const mermaidJs = fs.readFileSync(path.resolve('node_modules/mermaid/dist/mermaid.min.js'), 'utf8');

const files = [
  { in: 'webdesk-blueprint.html', out: 'GAIADA-WebDesk-Engineering-Blueprint.pdf', foot: 'GAIADA WebDesk — Engineering Blueprint' },
  { in: 'gaiada-blueprint.html',  out: 'Gaiada-AI-Platform-System-Blueprint.pdf', foot: 'Gaiada AI Platform — System Blueprint' },
  { in: 'search-marketing-blueprint.html', out: 'GAIADA-Search-Marketing-Engineering-Blueprint.pdf', foot: 'GAIADA Search-Marketing — Engineering Blueprint' },
  { in: 'smm-blueprint.html', out: 'GAIADA-Social-Media-Engineering-Blueprint.pdf', foot: 'GAIADA Social Media — Engineering Blueprint' },
  { in: 'creative-blueprint.html', out: 'GAIADA-Creative-Engineering-Blueprint.pdf', foot: 'GAIADA Creative — Engineering Blueprint' },
]
  // optional CLI filter: `node render-pdf.js creative` renders only matching entries (no arg = all)
  .filter(f => !process.argv[2] || f.in.includes(process.argv[2]));

// Reproduce the artifact LIGHT theme in print + page-fit diagrams + contents page,
// but COMPACT: use the full page width and let sections flow (no page-per-section waste).
const themeCss = `
  *{ -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
  html,body{ background:var(--paper) !important; }
  body{ font-size:10pt !important; }
  .themehint{ display:none !important; }

  /* --- use the FULL page width: drop the 74ch reading-measure cap for PDF --- */
  .main{ padding:0 !important; }
  .wrap{ max-width:none !important; }
  .wrap p,.wrap ul,.wrap ol,p,.note,.cols,.phases,.part>.dek,.cover .lede{ max-width:none !important; }
  .cols{ grid-template-columns:repeat(auto-fit,minmax(210px,1fr)) !important; gap:.6rem !important; margin:.8rem 0 !important; }

  /* --- flow sections instead of one page each; keep cover + contents standalone --- */
  .part{ break-before:auto !important; border-top:1px solid var(--line) !important;
         padding-top:1.1rem !important; margin-top:1.1rem !important; }
  .part:first-of-type{ break-before:auto !important; border-top:none !important; }
  .cover{ break-after:page !important; }
  .contents-page{ break-after:page !important; }

  /* --- tighten vertical rhythm --- */
  .part h2{ font-size:1.55rem !important; }
  .part>.dek{ font-size:.95rem !important; margin-top:.25rem !important; }
  h3{ margin:1.1rem 0 .35rem !important; font-size:1.08rem !important; }
  h4{ margin:.8rem 0 .25rem !important; }
  p{ margin:.5rem 0 !important; }
  figure{ margin:.9rem 0 !important; }
  .spec{ margin:.8rem 0 !important; }
  .tablewrap{ margin:.8rem 0 !important; }
  .note{ margin:.8rem 0 !important; padding:.7rem .9rem !important; }
  .phases{ gap:.4rem !important; }
  .plate{ padding:1rem .8rem .7rem !important; }

  /* --- keep atomic blocks whole; keep headings with their content --- */
  .plate{ overflow:visible !important; box-shadow:none !important; background:var(--plate) !important; border:1px solid var(--plate-line) !important; }
  .plate .mermaid{ min-width:0 !important; display:block !important; }
  .mermaid svg{ max-width:100% !important; max-height:210mm !important; width:auto !important; height:auto !important; display:block; margin:0 auto; }
  figure,.spec,.phase,.card,.note,.titleblock{ break-inside:avoid; }
  .tablewrap{ break-inside:auto; }
  .spec-head,tr,.part-head{ break-inside:avoid; }
  h2,h3,h4{ break-after:avoid; }
  .spec,.card,.tablewrap{ box-shadow:none !important; }

  /* contents page */
  .contents-page{ padding-top:.3rem; }
  .contents-title{ font-family:var(--serif); font-weight:600; font-size:1.8rem; color:var(--ink);
    margin:0 0 1rem; border-bottom:2px solid var(--ink); padding-bottom:.4rem; }
  .contents-list{ list-style:none; margin:0; padding:0; columns:2; column-gap:2.4rem; }
  .contents-list li{ display:flex; gap:.8rem; align-items:baseline; padding:.35rem .1rem;
    border-bottom:1px solid var(--line); font-size:.92rem; break-inside:avoid; }
  .contents-list .cn{ font-family:var(--mono); color:var(--accent); font-weight:600; min-width:2.2em; }
  .contents-note{ font-family:var(--mono); font-size:.7rem; color:var(--ink-faint); margin-top:1rem; letter-spacing:.02em; }
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
