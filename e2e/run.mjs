// End-to-end runner: build the app, start the servers over the fixture runs, run every
// e2e/tests/*.test.mjs with Node's test runner in a headless browser, stop the servers.
//
//   npm run e2e                      everything
//   npm run e2e -- --no-build        reuse dist/
//   E2E_BROWSER=edge npm run e2e     Edge instead of Chrome
//   E2E_RUN_IDS=e2e-prove npm run e2e   limit the Evaluation page checks to these fixture runs

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { startAll, APP_ROOT, DIST, FIXTURE_RUNS } from './server.mjs';

const args = new Set(process.argv.slice(2));

/** Run node with arguments, no shell (paths with spaces, as C:\Program Files\nodejs, stay intact). */
function run(nodeArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs, { cwd: APP_ROOT, env, stdio: 'inherit', windowsHide: true });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  if (!args.has('--no-build')) {
    const code = await run([path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], process.env);
    if (code !== 0) { console.error(`vite build exited ${code}`); process.exit(code); }
  }
  if (!(await fs.stat(path.join(DIST, 'index.html')).catch(() => null))) { console.error('dist/index.html missing; run without --no-build'); process.exit(1); }
  const runIds = (await fs.readdir(FIXTURE_RUNS).catch(() => [])).filter((d) => !d.startsWith('.') && !d.startsWith('_'));
  if (!runIds.length) console.warn(`no fixture runs under ${FIXTURE_RUNS}; the Evaluation page checks will be skipped (see TESTING.md, section 9)`);
  const servers = await startAll();
  console.log(`e2e: app ${servers.app}, run server ${servers.runs} (${runIds.join(', ') || 'no runs'}), jobs stub ${servers.jobs}`);
  const env = { ...process.env, E2E_BASE: servers.app, E2E_RUNS: servers.runs, E2E_JOBS: servers.jobs, E2E_RUN_IDS: process.env.E2E_RUN_IDS || runIds.join(',') };
  let code = 1;
  try {
    code = await run(['--test', '--test-concurrency=1', path.join('e2e', 'tests', '*.test.mjs')], env);
  } finally {
    await servers.close();
  }
  process.exit(code);
}

main().catch((err) => { console.error(err); process.exit(1); });
