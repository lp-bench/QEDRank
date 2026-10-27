// Selenium WebDriver for the end-to-end tests: headless Chrome (E2E_BROWSER=edge for Edge),
// the driver binary fetched by Selenium Manager. Helpers keep the tests short and strict:
// every wait has a timeout, and the browser console is checked for errors after each page.

import { Builder, By, until, logging } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import edge from 'selenium-webdriver/edge.js';

export { By, until };

export const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4180';
export const RUNS = process.env.E2E_RUNS || 'http://127.0.0.1:8790';
export const JOBS = process.env.E2E_JOBS || 'http://127.0.0.1:8791';
export const TIMEOUT = Number(process.env.E2E_TIMEOUT || 15000);

export async function makeDriver() {
  const browser = process.env.E2E_BROWSER || 'chrome';
  const prefs = new logging.Preferences();
  prefs.setLevel(logging.Type.BROWSER, logging.Level.WARNING);
  const args = ['--headless=new', '--window-size=1400,1100', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions'];
  const builder = new Builder();
  if (browser === 'edge') builder.forBrowser('MicrosoftEdge').setEdgeOptions(new edge.Options().addArguments(...args).setLoggingPrefs(prefs));
  else builder.forBrowser('chrome').setChromeOptions(new chrome.Options().addArguments(...args).setLoggingPrefs(prefs));
  const driver = await builder.build();
  await driver.manage().setTimeouts({ pageLoad: 60000, script: 30000 });
  return driver;
}

/** Open a route of the app and wait for React to render its <main>. */
export async function open(driver, route = '/') {
  await driver.get(`${BASE}${route}`);
  await driver.wait(until.elementLocated(By.css('main')), TIMEOUT);
}

/** Wait for an element and return it. */
export function find(driver, css, timeout = TIMEOUT) {
  return driver.wait(until.elementLocated(By.css(css)), timeout);
}

/** An element's text, or '' when React replaced the element while we were looking (stale reference). */
async function textOf(el) {
  try { return await el.getText(); } catch (e) { if (e.name === 'StaleElementReferenceError') return ''; throw e; }
}

/** Wait until some element matching `css` contains `text`; returns that element. */
export async function findText(driver, css, text, timeout = TIMEOUT) {
  let found = null;
  await driver.wait(async () => {
    for (const el of await driver.findElements(By.css(css))) {
      if ((await textOf(el)).includes(text)) { found = el; return true; }
    }
    return false;
  }, timeout, `no <${css}> containing "${text}"`);
  return found;
}

/** The first element matching `css` whose text contains `text`, now, or null. */
export async function byText(driver, css, text) {
  for (const el of await driver.findElements(By.css(css))) if ((await textOf(el)).includes(text)) return el;
  return null;
}

/** Click the first button (or link) whose text contains `text`. */
export async function click(driver, text, css = 'button, a') {
  const el = await findText(driver, css, text);
  await driver.executeScript('arguments[0].scrollIntoView({block: "center"})', el);
  await el.click();
  return el;
}

/**
 * Replace an input's value so that React's controlled input sees it: the native setter (React
 * patches the property) followed by an `input` event. Keyboard chords are avoided on purpose —
 * WebDriver holds a modifier key for the rest of a sendKeys call, which garbles what follows.
 */
export async function type(driver, el, value) {
  await driver.executeScript(`
    const el = arguments[0], value = arguments[1];
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  `, el, String(value));
}

/** The input that follows a label containing `labelText`. */
export async function inputOf(driver, labelText, timeout = TIMEOUT) {
  const label = await findText(driver, 'label', labelText, timeout);
  return label.findElement(By.css('input, select, textarea'));
}

/** Console errors since the last call (chromedriver keeps them per session). */
export async function consoleErrors(driver) {
  try {
    const entries = await driver.manage().logs().get(logging.Type.BROWSER);
    return entries.filter((e) => e.level.name === 'SEVERE').map((e) => e.message).filter((m) => !/favicon|ERR_CONNECTION_REFUSED|net::ERR|the server responded with a status of 404 .*\/api\/feedback/.test(m));
  } catch {
    return [];
  }
}

export function assertNoConsoleErrors(errors, assert, where) {
  assert.deepEqual(errors, [], `${where}: browser console errors`);
}
