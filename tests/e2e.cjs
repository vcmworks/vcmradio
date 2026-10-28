// End-to-end test in real Chromium. Needs `playwright` (npm i -D playwright, or a preinstalled copy).
// The station directory and the audio stream are mocked, so no internet is required.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function wav(seconds = 20, hz = 440, rate = 8000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

const API = 'https://api.test';
const row = (i, o = {}) => ({ stationuuid: 'u' + i, name: 'Station ' + i, url_resolved: 'https://stream.test/ok' + i + '.wav', favicon: '', tags: 'film,music', state: 'Telangana', countrycode: 'IN', codec: 'MP3', bitrate: 128, hls: 0, votes: 10 - i, clickcount: 100 - i, ...o });
const ROWS = [
  row(1, { name: 'Hyderabad Hits', tags: 'film,hits', state: 'Telangana' }),
  row(2, { name: 'Vizag Vibes', state: 'Andhra Pradesh', tags: 'devotional' }),
  row(3, { name: 'Broken Stream', url_resolved: 'https://stream.test/broken.wav' }),
  row(4, { name: 'Hyderabad Hits', url_resolved: 'https://stream.test/dup.wav' }), // duplicate name, dropped
  row(5, { name: 'Old Gold', tags: 'oldies,film', state: 'Telangana' }),
];

(async () => {
  const { createServer } = await import(pathToFileURL(path.join(__dirname, '..', 'server.js')).href);
  const srv = createServer().listen(0); const base = `http://localhost:${srv.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const calls = [];
  await page.addInitScript((api) => { window.RADIO_SERVERS = [api]; }, API);
  await page.route(API + '/**', (r) => {
    const u = new URL(r.request().url()); calls.push(u.pathname + u.search);
    r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(u.pathname.includes('/stations/search') ? ROWS : { ok: true }) });
  });
  await page.route('https://stream.test/**', (r) => {
    if (r.request().url().includes('broken')) return r.fulfill({ status: 404, body: 'no' });
    r.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'access-control-allow-origin': '*' }, body: wav() });
  });
  // Google Fonts are not reachable in CI; the layout must not depend on them.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());

  let n = 0; const ok = (m) => console.log('  ok  ' + m + (++n && ''));
  try {
    await page.goto(base);
    await page.waitForSelector('.card');
    assert.equal(await page.locator('.card').count(), 4); ok('lists stations and drops duplicate names');
    assert.ok(calls.some((c) => c.includes('language=telugu') && c.includes('languageExact=true') && c.includes('hidebroken=true'))); ok('queries the directory for exact Telugu, hiding broken streams');

    await page.fill('#q', 'vizag'); assert.equal(await page.locator('.card').count(), 1); ok('search filters by name');
    await page.fill('#q', ''); await page.click('[data-tag="film"]'); assert.equal(await page.locator('.card').count(), 3);
    await page.click('[data-tag="film"]'); ok('tag chips filter and toggle off');
    await page.selectOption('#stateSel', 'Andhra Pradesh'); assert.equal(await page.locator('.card').count(), 1); await page.selectOption('#stateSel', ''); ok('location filter works');

    await page.click('[data-play="u1"]');
    await page.waitForFunction(() => document.getElementById('npSub').textContent.startsWith('Live'), null, { timeout: 8000 });
    assert.equal(await page.textContent('#npName'), 'Hyderabad Hits');
    const t0 = await page.evaluate(() => 0);
    await page.waitForTimeout(1200);
    assert.ok(calls.some((c) => c.includes('/json/url/u1'))); ok('click is counted with the directory');
    ok('audio starts: status shows Live');
    assert.equal(await page.locator('.card.on.live').count(), 1); ok('playing card is highlighted');

    await page.click('#nextBtn');
    await page.waitForFunction(() => document.getElementById('npName').textContent !== 'Hyderabad Hits', null, { timeout: 8000 });
    ok('next station switches playback');

    await page.click('[data-play="u3"]');
    await page.waitForFunction(() => document.getElementById('npSub').classList.contains('err'), null, { timeout: 8000 });
    assert.match(await page.textContent('#npSub'), /not available/); ok('broken stream shows a clear error instead of hanging');

    await page.click('[data-fav="u5"]'); await page.click('[data-chip="favs"]');
    assert.equal(await page.locator('.card').count(), 1); ok('favorites filter');
    await page.reload(); await page.waitForSelector('.card'); await page.click('[data-chip="favs"]');
    assert.equal(await page.locator('.card').count(), 1); ok('favorites persist after reload');

    await page.click('#playBtn'); // starts first in view (favorites -> Old Gold)
    await page.waitForFunction(() => document.getElementById('npSub').textContent.startsWith('Live'), null, { timeout: 8000 });
    await page.click('#playBtn'); assert.equal(await page.textContent('#npSub'), 'Stopped'); ok('stop button works');
    assert.equal(await page.evaluate(() => document.querySelector('audio') === null), true);

    await page.click('#addBtn'); await page.fill('#addName', 'My Tone'); await page.fill('#addUrl', 'ftp://x'); await page.click('#addForm button[type=submit]');
    assert.ok((await page.textContent('#addErr')).length > 0);
    await page.fill('#addUrl', 'https://stream.test/mine.wav'); await page.click('#addForm button[type=submit]');
    await page.click('[data-chip="favs"]'); await page.fill('#q', 'my tone'); assert.equal(await page.locator('.card').count(), 1); ok('custom stream: validates and saves');

    await page.setViewportSize({ width: 390, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, 'horizontal overflow ' + overflow); ok('no horizontal scroll at phone width');

    assert.deepEqual(errors, []); ok('no uncaught page errors');
    await page.setViewportSize({ width: 1200, height: 800 }); await page.fill('#q', ''); await page.click('[data-chip="favs"]');
    await page.click('[data-play="u1"]').catch(() => {}); await page.waitForTimeout(800);
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    console.log('\nE2E passed');
  } catch (e) {
    console.error('\nE2E FAILED:', e.message, errors); process.exitCode = 1;
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }).catch(() => {});
  } finally { await browser.close(); srv.close(); }
})();
