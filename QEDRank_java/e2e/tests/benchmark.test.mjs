// The Benchmark page end to end against the fixture corpora: discovery (the same code as the
// deployed preview function, over local folders), the manifest, and the run launcher — including
// what it sends to the run server. The attempts check guards the bug of 2026-10-26, when the page
// started a run with 1 attempt although 16 were asked for.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeDriver, open, find, findText, byText, click, type, inputOf, consoleErrors, assertNoConsoleErrors, By, JOBS } from '../driver.mjs';

let driver;
before(async () => { driver = await makeDriver(); });
after(async () => { await driver?.quit(); });

async function discover(repoUrl, expected) {
  await open(driver, '/benchmark');
  // The launcher asks the run server for harnesses and configurations: the e2e stub, never
  // whatever happens to listen on the default port of the machine running the tests.
  await driver.executeScript('localStorage.setItem("qedrank.runServer", JSON.stringify(arguments[0]))', JOBS);
  await open(driver, '/benchmark');
  await findText(driver, 'h1', 'Evaluate Models on a Benchmark');
  await type(driver, await inputOf(driver, 'Repository, branch or folder link'), repoUrl);
  if (expected) await type(driver, await inputOf(driver, 'Expected paper count'), String(expected));
  await click(driver, 'Preview manifest');
  await findText(driver, '.qr-kv', 'Papers discovered', 30000);
}

test('corpus-b (ProofBench layout): papers, PDFs from the database folder, targets per paper', async () => {
  await discover('https://github.com/e2e/corpus-b', 5);
  const kv = await find(driver, '.qr-kv');
  const text = await kv.getText();
  assert.match(text, /Papers discovered\s*5\s*of expected 5 — matches the expectation/);
  assert.match(text, /Discovery folder\s*Bench\/PROBLEMS/);
  assert.match(text, /With PDF\s*3/, 'PDFs matched from the database folder and the paper folders');
  assert.match(text, /Main theorem: 5/);
  const rows = await driver.findElements(By.css('.qr-table tbody tr'));
  assert.equal(rows.length, 5);
  assert.match(await rows[0].getText(), /P001/);
  await findText(driver, '.qr-note pre', 'node qedrank/cli.js run --repo https://github.com/e2e/corpus-b');
  assertNoConsoleErrors(await consoleErrors(driver), assert, 'benchmark corpus-b');
});

test('corpus-a (papers layout) and an unknown repository', async () => {
  await discover('https://github.com/e2e/corpus-a', 3);
  assert.match(await (await find(driver, '.qr-kv')).getText(), /Papers discovered\s*3\s*of expected 3/);
  await open(driver, '/benchmark');
  await type(driver, await inputOf(driver, 'Repository, branch or folder link'), 'https://github.com/e2e/does-not-exist');
  await click(driver, 'Preview manifest');
  const err = await findText(driver, '.error-message', 'not found');
  assert.match(await err.getText(), /Repository not found/);
  // The provoked 404 of the discover endpoint is the one console error allowed here.
  assertNoConsoleErrors((await consoleErrors(driver)).filter((m) => !/\/api\/qedrank\/discover .*404/.test(m)), assert, 'benchmark corpus-a');
});

test('run launcher: the command preview and the request carry the attempts the user asked for', async () => {
  await discover('https://github.com/e2e/corpus-b', 5);
  await findText(driver, 'h3', 'Run the benchmark from here');
  await type(driver, await inputOf(driver, 'Run server'), JOBS);
  await type(driver, await inputOf(driver, 'Run id'), 'e2e-launch');
  await type(driver, await inputOf(driver, 'Independent attempts per problem and model'), '16');
  const pre = await find(driver, 'pre.qr-cmd');
  await driver.wait(async () => /--attempts 16/.test(await pre.getText()), 5000, 'the command preview shows --attempts 16');
  // Attempts above 1 with no temperature set: the page samples at 1.0 instead of repeating one answer.
  assert.match(await pre.getText(), /--temperature 1\b/);
  await findText(driver, '.qr-small', 'temperature 1.0 will be sent');
  // A run configuration from the run server: its attempts become the default, its sampling applies.
  const cfgSelect = await find(driver, 'select.qr-run-config');
  await driver.wait(async () => (await cfgSelect.findElements(By.css('option'))).length > 1, 5000, 'configs listed');
  await driver.executeScript(`const s = arguments[0]; s.value = arguments[1]; s.dispatchEvent(new Event('change', { bubbles: true }));`, cfgSelect, 'glm-prove-pass4.json');
  await driver.wait(async () => /--config configs\/glm-prove-pass4\.json/.test(await pre.getText()) && /--attempts 4\b/.test(await pre.getText()), 5000, 'the configuration and its attempts in the preview');
  await type(driver, await inputOf(driver, 'Independent attempts per problem and model'), '16');
  await driver.wait(async () => /--attempts 16/.test(await pre.getText()), 5000, 'attempts raised to 16 over the configuration');
  const cmd = await pre.getText();
  assert.match(cmd, /^node qedrank\/cli\.js run /);
  assert.match(cmd, /--task prove/);
  assert.match(cmd, /--run-id e2e-launch/);
  assert.doesNotMatch(cmd, /--temperature/, 'the configuration already samples (T 1.0): no override');
  // Start: the stub records the request and answers with a finished job, whose run the page then
  // loads by itself — no "Load a run" step anywhere on the page.
  await click(driver, 'Start');
  await driver.wait(async () => Boolean(await byText(driver, '.qr-launch, main', 'stub job')), 20000, 'the job log arrives');
  await findText(driver, '.qr-launch', 'loaded into Evaluation', 20000);
  await findText(driver, 'h2', 'Explore the loaded run');
  assert.equal(await byText(driver, 'h2', 'Load a run'), null, 'the loader card is gone');
  const rec = await (await fetch(`${JOBS}/__recorded`)).json();
  assert.equal(rec.recorded.length, 1);
  const body = rec.recorded[0].body;
  assert.equal(body.command, 'run');
  assert.equal(body.runId, 'e2e-launch');
  assert.equal(body.task, 'prove');
  assert.equal(body.attempts, 16, 'the single-call request carries attempts');
  assert.equal(body.config, 'glm-prove-pass4.json', 'and the chosen run configuration');
  assert.equal(body.temperature, undefined);
  assert.equal(rec.recorded[0].client, 'web');
  assertNoConsoleErrors(await consoleErrors(driver), assert, 'benchmark launcher');
});
