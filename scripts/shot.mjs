// Verification helper: node scripts/shot.mjs <url> <out.png> [seconds]
// Opens the page in local Chrome (headless, WebGPU enabled), waits, prints backend/fps/console errors, saves a screenshot.
import puppeteer from 'puppeteer-core';

const [url, out = 'shot.png', secs = '8'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, Number(secs) * 1000));
const info = await page.evaluate(() => {
  const s = window.slime;
  return s ? { backend: s.backend, fps: Math.round(s.fps), agents: s.state.settings.numAgents } : null;
});
const err = await page.$eval('#error', (e) => (e.style.display === 'flex' ? e.textContent : ''));
await page.screenshot({ path: out });
console.log(JSON.stringify({ info, error: err, logs }, null, 2));
await browser.close();
