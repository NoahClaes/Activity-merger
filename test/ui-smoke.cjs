// Headless UI check: loads sample files, switches tabs and themes, takes screenshots.
const { chromium } = require('playwright');
const path = require('path');
const out = process.argv[2] || '.';
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto('file://' + path.resolve('src/renderer/index.html'));
    await page.screenshot({ path: `${out}/empty-${scheme}.png` });
    await page.setInputFiles('#file-input', ['test/samples/zwift.fit', 'test/samples/watch.fit']);
    await page.waitForSelector('table.files');
    await page.screenshot({ path: `${out}/files-${scheme}.png`, fullPage: true });
    // tick heart rate in row 1? zwift has none; untick watch temperature
    await page.click('#tab-charts');
    await page.waitForSelector('.chart');
    const over = await page.locator('.chart .u-over').first().boundingBox();
    await page.mouse.move(over.x + over.width * 0.3, over.y + 50);
    await page.mouse.down();
    await page.mouse.move(over.x + over.width * 0.45, over.y + 50, { steps: 8 });
    await page.mouse.up();
    await page.screenshot({ path: `${out}/charts-${scheme}.png` });
    await page.click('#selection-bar button:has-text("Apply")');
    await page.click('#tab-files');
    console.log(scheme, await page.evaluate(() => ({ overrides: window.__state.overrides.length, n: window.__state.merged.records.length })));
  }
  // theme toggle persists
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await page.goto('file://' + path.resolve('src/renderer/index.html'));
  await page.click('[data-theme-choice="dark"]');
  await page.reload();
  console.log('theme after reload:', await page.evaluate(() => document.documentElement.dataset.theme), 'bg:', await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
  console.log('errors:', errors);
  await browser.close();
})();
