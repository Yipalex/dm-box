// Optional browser check against an isolated, seeded test service.
// Requires Playwright; DMBOX_TEST_BASE and DMBOX_TEST_TOKEN must refer to disposable test data.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ httpCredentials: {
      username: 'dmbox', password: process.env.DMBOX_TEST_TOKEN,
    }, viewport: { width: 1280, height: 850 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // Exercise the ordinary download fallback without opening an OS save dialog.
    await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
    await page.goto(process.env.DMBOX_TEST_BASE);
    await page.locator('#stats-line').filter({ hasText: '1 条消息' }).waitFor();
    await page.locator('.contact[data-uid="123"]').click();
    await page.locator('.bubble').filter({ hasText: 'NAS browser sample' }).waitFor();
    assert.equal(await page.evaluate(async () => (await fetch('/media/sample.txt')).status), 200);
    await page.locator('#btn-export').click();
    const downloadReady = page.waitForEvent('download');
    await page.locator('#exp-go').click();
    const download = await downloadReady;
    assert.match(download.suggestedFilename(), /\.html$/);
    if (process.env.DMBOX_TEST_SCREENSHOT) await page.screenshot({ path: process.env.DMBOX_TEST_SCREENSHOT });
    assert.deepEqual(errors, []);
    console.log('Browser: authenticated management, contact/message display, media access and HTML download passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
