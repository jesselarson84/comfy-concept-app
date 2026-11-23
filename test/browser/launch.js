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

/** Batch 8: pick a ratio in the ratio grid ('1:1', '16:9-landscape', '3:2-portrait' ...). */
export async function pickAspect(page, key) {
  if (!(await page.isVisible('#aspect-pop'))) await page.click('#aspect-btn');
  await page.click(`#aspect-pop .ar-opt[data-aspect="${key}"]`);
  await page.waitForSelector('#aspect-pop', { state: 'hidden' });
}
