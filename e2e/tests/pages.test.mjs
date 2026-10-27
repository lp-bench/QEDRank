// Every route renders, the navigation works, and the pages that need no data show their empty
// states without console errors. The Convert page refuses to send anything when no model has a
// key — the state of a fresh machine and of CI.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeDriver, open, find, findText, byText, click, consoleErrors, assertNoConsoleErrors, By, BASE } from '../driver.mjs';

let driver;
before(async () => { driver = await makeDriver(); });
after(async () => { await driver?.quit(); });

test('home: hero, both workflows, roster count from /api/models', async () => {
  await open(driver, '/');
  const h1 = await find(driver, 'h1');
  assert.match(await h1.getText(), /Formal Mathematics/);
  await findText(driver, 'a.btn', 'Evaluate Models');
  await findText(driver, 'a.btn', 'Compare Benchmarks');
  // The roster loads from the in-process /api/models: ten slots, none with a key on this machine.
  const stat = await findText(driver, '.stat', 'Models in the roster');
  await driver.wait(async () => /\d/.test(await stat.findElement(By.css('.value')).getText()), 10000);
  assert.equal(await stat.findElement(By.css('.value')).getText(), '10');
  assertNoConsoleErrors(await consoleErrors(driver), assert, 'home');
});

test('navigation: the top bar reaches every page and the unknown route falls back to home', async () => {
  await open(driver, '/');
  for (const [text, route, heading] of [['Evaluate Models', '/benchmark', 'Evaluate Models on a Benchmark'], ['Compare Benchmarks', '/versus', null], ['Convert', '/convert', 'Convert a Problem']]) {
    await click(driver, text, 'a');
    await driver.wait(async () => (await driver.getCurrentUrl()).includes(route), 10000, `route ${route}`);
    if (heading) await findText(driver, 'h1', heading);
  }
  await driver.get(`${BASE}/no-such-page`);
  await driver.wait(async () => new URL(await driver.getCurrentUrl()).pathname === '/', 10000);
  assertNoConsoleErrors(await consoleErrors(driver), assert, 'navigation');
});

test('evaluation without a run server: no loader to operate, one line that says what to start', async () => {
  await open(driver, '/evaluation');
  await driver.executeScript('sessionStorage.clear(); localStorage.setItem("qedrank.runServer", JSON.stringify("http://127.0.0.1:1"))');
  await open(driver, '/evaluation');
  const note = await findText(driver, '.qr-run-switch', 'No run server at http://127.0.0.1:1');
  assert.match(await note.getText(), /npm run qedrank:serve/);
  assert.equal(await byText(driver, 'h2', 'Load a run'), null, 'the old loader card is gone');
  assert.equal(await byText(driver, 'button', 'List runs'), null);
  // The connection failure is the one console error allowed here.
  assertNoConsoleErrors((await consoleErrors(driver)).filter((m) => !/127\.0\.0\.1:1\//.test(m)), assert, 'evaluation empty');
});

test('compare and versus render their empty states', async () => {
  await open(driver, '/compare');
  await find(driver, 'main');
  assertNoConsoleErrors(await consoleErrors(driver), assert, 'compare');
  await open(driver, '/versus');
  await find(driver, 'main');
  assertNoConsoleErrors(await consoleErrors(driver), assert, 'versus');
});

test('convert: with no keys the page explains instead of calling any model', async () => {
  await open(driver, '/convert');
  await findText(driver, 'h1', 'Convert a Problem');
  // Every roster card says "no key"; the model picker is populated from /api/models.
  await driver.wait(async () => (await driver.findElements(By.css('.mp-card, .model-card, [data-model], .picker-card'))).length > 0 || (await driver.findElements(By.css('main'))).length > 0, 10000);
  const area = await find(driver, 'textarea#mathProblem');
  await area.sendKeys('For all natural numbers a and b, a + b = b + a.');
  await click(driver, 'Generate with');
  const err = await findText(driver, '.error-message', 'API key');
  assert.match(await err.getText(), /None of the selected models has an API key|Select at least one model/);
  assert.equal(await byText(driver, '.pill', 'running'), null, 'nothing was started');
  assertNoConsoleErrors(await consoleErrors(driver), assert, 'convert');
});
