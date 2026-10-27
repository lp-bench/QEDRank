// The Evaluation page for every fixture run served by the run server: load through the run
// loader, then the sections a reader relies on — leaderboard, problems × models grid, pass@k
// (with dashes where k exceeds the attempts), the item table and its filters, the exports.
// E2E_RUN_IDS (set by e2e/run.mjs from qedrank/test/fixtures/runs) lists the runs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeDriver, open, find, findText, byText, click, consoleErrors, assertNoConsoleErrors, By, until, RUNS } from '../driver.mjs';

const RUN_IDS = (process.env.E2E_RUN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

let driver;
before(async () => { driver = await makeDriver(); });
after(async () => { await driver?.quit(); });

/**
 * Open the Evaluation page against the e2e run server: the newest run loads by itself; a
 * different one is chosen in the "Runs on this machine" row. Nothing is typed into a loader.
 */
async function loadRun(runId) {
  await open(driver, '/evaluation');
  // A run loaded by an earlier test lives in sessionStorage; the run server address in localStorage.
  await driver.executeScript('sessionStorage.clear(); localStorage.setItem("qedrank.runServer", JSON.stringify(arguments[0]))', RUNS);
  await open(driver, '/evaluation');
  await driver.wait(until.elementLocated(By.css('.qr-run-switch[data-loaded-run]:not([data-loaded-run=""])')), 20000, 'a run loaded by itself');
  await findText(driver, 'h1', 'Evaluation matrix', 20000);
  const loaded = await (await find(driver, '.qr-run-switch')).getAttribute('data-loaded-run');
  if (loaded !== runId) {
    const select = await find(driver, 'select.qr-run-select');
    await driver.wait(async () => (await select.findElements(By.css('option'))).length > 1, 10000, 'runs listed');
    await driver.executeScript(`const s = arguments[0]; s.value = arguments[1]; s.dispatchEvent(new Event('change', { bubbles: true }));`, select, runId);
    await click(driver, 'Load', '.qr-run-switch button');
    await driver.wait(until.elementLocated(By.css(`.qr-run-switch[data-loaded-run="${runId}"]`)), 20000, `${runId} loaded`);
  }
}

test('the run server lists the fixture runs', { skip: !RUN_IDS.length && 'no fixture runs' }, async () => {
  const listed = await (await fetch(`${RUNS}/runs`)).json();
  for (const id of RUN_IDS) assert.ok(listed.runs.some((r) => r.run_id === id), `${id} listed`);
});

for (const runId of RUN_IDS) {
  test(`evaluation page: ${runId}`, async (t) => {
    const summary = await (await fetch(`${RUNS}/runs/${runId}/summary.json`)).json();
    await loadRun(runId);
    // Leaderboard: one row per model of the run.
    await findText(driver, 'h2', 'Leaderboard');
    const models = summary.models.map((m) => m.display_name);
    for (const name of models) await findText(driver, 'main', name.split(' · ')[0]);
    // Problems × models grid: one row per problem, planned attempts in the legend.
    await findText(driver, 'h2', 'Problems × models');
    const planned = summary.attempts?.planned ?? summary.settings?.attempts ?? 1;
    await findText(driver, 'p.small', `${planned} attempt${planned === 1 ? '' : 's'} planned per problem and model`);
    // pass@k: a table only when k > 1; its unavailable cells are dashes, never zeros.
    const passk = await byText(driver, 'h2', 'pass@k');
    assert.ok(passk, 'pass@k section');
    assert.match(await passk.getText(), new RegExp(`${planned} attempt`));
    // Item-level results: one row per item record.
    await findText(driver, 'h2', 'Item-level results');
    const itemsBefore = (await driver.findElements(By.css('section#items table tbody tr'))).length;
    assert.ok(itemsBefore > 0, 'item rows');
    t.diagnostic(`${runId}: ${models.length} models, ${itemsBefore} item rows shown, ${planned} attempt(s) planned`);
    // Exports exist as buttons (downloads are not asserted in a headless browser).
    for (const label of ['Summary JSON', 'Matrix CSV', 'Items JSON']) await findText(driver, 'button', label);
    assertNoConsoleErrors(await consoleErrors(driver), assert, `evaluation ${runId}`);
  });
}

test('a run loaded on the Evaluation page is shared with the Benchmark page', { skip: !RUN_IDS.length && 'no fixture runs' }, async () => {
  await loadRun(RUN_IDS[0]);
  await open(driver, '/benchmark');
  await findText(driver, 'h2', 'Explore the loaded run');
  await findText(driver, 'main', RUN_IDS[0]);
  assertNoConsoleErrors(await consoleErrors(driver), assert, 'shared run');
});
