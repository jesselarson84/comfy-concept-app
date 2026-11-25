// launch.js - start headless Chromium for the browser tests.
// Linux VM / CI: uses @sparticuz/chromium (a Chromium shipped inside an npm
// package, so no separate browser download is needed).
// Windows: falls back to your installed Chrome (playwright-core channel "chrome").
import { chromium } from 'playwright-core';

export async function launch() {
  if (process.platform === 'linux') {
    try {
      const { default: sparticuz } = await import('@sparticuz/chromium');
      return chromium.launch({ executablePath: await sparticuz.executablePath(), args: sparticuz.args, headless: true });
    } catch (e) { if (!process.env.CHROME_PATH) throw e; }
  }
  if (process.env.CHROME_PATH) return chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  return chromium.launch({ channel: 'chrome', headless: true });
}

/** Batch 10: open the ⋮ menu of a full-screen view (scope '.viewer', '.model-viewer' ...) and tap a row
 *  (favorite, save, share, reference, reuse, delete). */
export async function menuAct(page, scope, act) {
  await page.click(`${scope} [data-act="more"]`);
  await page.click(`.amenu [data-act="${act}"]`);
  await page.waitForSelector('.amenu', { state: 'detached' });
}

/** Batch 10: "Save to this phone instead" (the old Save button) from a view's ⋮ menu. */
export async function saveToPhone(page, scope) {
  await menuAct(page, scope, 'save');
  await page.click('.drive-sheet [data-act="phone"]');
}

/** Batch 8: pick a ratio in the ratio grid ('1:1', '16:9-landscape', '3:2-portrait' ...). */
export async function pickAspect(page, key) {
  if (!(await page.isVisible('#aspect-pop'))) await page.click('#aspect-btn');
  await page.click(`#aspect-pop .ar-opt[data-aspect="${key}"]`);
  await page.keyboard.press('Escape'); // the grid stays open after a pick
  await page.waitForSelector('#aspect-pop', { state: 'hidden' });
}

/** Batch 15: pick a value in one of the app's own dropdowns (ui/dropdown.js) and close it
 *  (it stays open after a pick). sel = the .dd element (or something inside it). */
export async function pickOption(page, sel, value) {
  await page.click(`${sel} .dd-btn`);
  await page.click(`.dd-pop .dd-opt[data-value="${value}"]`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dd-pop', { state: 'detached' });
}

/** Batch 15: the options a dropdown offers ([value, label] pairs), read by opening it. */
export async function dropdownOptions(page, sel) {
  await page.click(`${sel} .dd-btn`);
  const out = await page.$$eval('.dd-pop .dd-opt', (b) => b.map((x) => [x.dataset.value, x.textContent]));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dd-pop', { state: 'detached' });
  return out;
}

/**
 * Batch 19: tap the Files toggle; when that opened Files, open every project too
 * (projects start collapsed, so their tiles are not built until opened).
 */
export async function toggleFiles(page) {
  await page.click('#btn-history');
  if (!(await page.isVisible('.history'))) return;
  await expandFiles(page);
}

/** Batch 19: open every collapsed project in Files (after the list has loaded). */
export async function expandFiles(page) {
  await page.waitForFunction(() => { const l = document.querySelector('.history-list'); return l && !/Loading…/.test(l.textContent); });
  for (let i = 0; i < 50; i++) {
    const h3 = await page.$('.history-session.closed h3');
    if (!h3) return;
    await h3.click();
  }
}
