// Renders build/icon.svg to PNG sizes for electron-builder (one-off tool).
// Uses the system Chrome via puppeteer-core — no Chromium download needed.
// Usage: node scripts/make-icons.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const chromeCandidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const executablePath = chromeCandidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!executablePath) {
  console.error('Chrome not found — install Chrome or adjust chromeCandidates.');
  process.exit(1);
}

const svg = fs.readFileSync('build/icon.svg', 'utf8');
const sizes = [512, 256, 128, 64, 32];
fs.mkdirSync('build', { recursive: true });

const browser = await puppeteer.launch({ executablePath, headless: true });
const page = await browser.newPage();
for (const size of sizes) {
  const scaled = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  const html = `<!DOCTYPE html><html><body style="margin:0;background:transparent">${scaled}</body></html>`;
  await page.setViewport({ width: size, height: size });
  await page.setContent(html);
  const el = await page.$('svg');
  await el.screenshot({ path: path.join('build', `icon-${size}.png`), omitBackground: true });
  console.log(`built build/icon-${size}.png`);
}
await browser.close();
console.log('done');
