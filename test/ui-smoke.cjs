const { chromium } = require('playwright');
const path = require('path');
const out = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, colorScheme: scheme });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto('file://' + path.resolve('src/renderer/index.html'));
    if (scheme === 'light') await page.screenshot({ path: `${out}/empty.png` });
    await page.setInputFiles('#file-input', ['test/samples/zwift.fit', 'test/samples/watch.fit']);
    await page.waitForSelector('.chart');
    // drag-select on the first chart
    const over = await page.locator('.chart .u-over').first().boundingBox();
    await page.mouse.move(over.x + over.width * 0.3, over.y + 50);
    await page.mouse.down();
    await page.mouse.move(over.x + over.width * 0.45, over.y + 50, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/loaded-${scheme}.png` });
    const s = await page.evaluate(() => ({ n: window.__state.merged.records.length, hr: window.__state.merged.records.filter(r => r.hr != null).length, sel: window.__state.selection, sources: window.__state.sources }));
    console.log(scheme, JSON.stringify(s), 'errors:', errors);
    if (scheme === 'light') {
      await page.selectOption('#selection-bar select >> nth=0', 'hr');
      await page.selectOption('#selection-bar select >> nth=1', '');
      await page.click('#selection-bar button:has-text("Apply")');
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${out}/override.png` });
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
      await dl.saveAs(`${out}/merged.fit`);
      console.log('downloaded', dl.suggestedFilename(), 'errors:', errors);
    }
  }
  await browser.close();
})();
