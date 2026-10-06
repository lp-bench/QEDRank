// What produced a run: the commit of this harness, and whether the working tree had
// uncommitted changes when the run started.

import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * { commit, short, branch, dirty, changed_files } of the checkout this code runs from.
 * `commit` is null outside a git checkout (for example inside a container image built
 * without .git); set QEDRANK_HARNESS_COMMIT in that case and it is recorded as given.
 */
export async function harnessRevision({ cwd = REPO_ROOT, env = process.env } = {}) {
  const raw = async (...args) => (await execFileP('git', ['-C', cwd, ...args], { timeout: 15000, windowsHide: true })).stdout;
  const git = async (...args) => (await raw(...args)).trim();
  try {
    const commit = await git('rev-parse', 'HEAD');
    // Porcelain lines are "XY <path>"; the status columns may be blank, so the lines are not trimmed.
    const status = await raw('status', '--porcelain', '--untracked-files=no');
    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => null);
    const changed = status.split(/\r?\n/).filter((l) => l.length > 3).map((l) => l.slice(3));
    return { commit, short: commit.slice(0, 10), branch, dirty: changed.length > 0, changed_files: changed.slice(0, 50), source: 'git' };
  } catch {
    const given = env.QEDRANK_HARNESS_COMMIT || null;
    return { commit: given, short: given ? given.slice(0, 10) : null, branch: null, dirty: null, changed_files: [], source: given ? 'QEDRANK_HARNESS_COMMIT' : 'unavailable' };
  }
}
