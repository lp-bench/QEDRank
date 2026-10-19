// Private-corpus guard. A private corpus (ProofBench) must not reach a hosted model by accident:
// when `privacy.privateCorpus` is on, every model slot of a run has to resolve to an endpoint on
// an allow-list of hosts, and the check runs before any request is sent. The outcome is recorded
// on the run so a reader can see which hosts received statements. Pure functions, no I/O.

import { resolveBaseUrl, resolveModelId, getProvider } from '../../lib/providers.js';

/** Hosts that are always this machine. */
export const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);

/** Host name of an endpoint URL (lower case, no port), or null when it cannot be parsed. */
export function hostOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase() || null; } catch { return null; }
}

/**
 * True when `host` is loopback or matches an allow-list entry: an exact host name, or a
 * leading-dot suffix (`.tu-freiberg.de` matches `lgnode001.tu-freiberg.de`).
 */
export function hostAllowed(host, allowedHosts = []) {
  const h = String(host || '').toLowerCase().trim();
  if (!h) return false;
  if (LOOPBACK_HOSTS.includes(h) || /^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  for (const entry of allowedHosts || []) {
    const a = String(entry || '').toLowerCase().trim();
    if (!a) continue;
    if (a.startsWith('.') ? (h === a.slice(1) || h.endsWith(a)) : h === a) return true;
  }
  return false;
}

/** The policy in force, from the config (`privacy.privateCorpus`, `privacy.allowedHosts`). */
export function privacyPolicy(config) {
  const p = config?.privacy || {};
  return {
    private_corpus: Boolean(p.privateCorpus),
    allowed_hosts: [...new Set([...LOOPBACK_HOSTS, ...(Array.isArray(p.allowedHosts) ? p.allowedHosts : [])].map((h) => String(h).toLowerCase().trim()).filter(Boolean))],
  };
}

/**
 * Check every slot of a run against the policy.
 * @param {object} p
 * @param {object} p.config   run configuration
 * @param {string[]} p.slots  provider ids of the run
 * @param {object} [p.env]    environment holding endpoint overrides (no key is read)
 * @param {string} [p.mode]   'fixture' runs send nothing and are always allowed
 * @returns {{enforced:boolean, private_corpus:boolean, allowed_hosts:string[], slots:object[], refused:string[]}}
 */
export function checkPrivateCorpus({ config, slots, env = process.env, mode = null }) {
  const policy = privacyPolicy(config);
  const fixture = mode === 'fixture';
  const rows = (slots || []).map((slot) => {
    let host = null;
    let kind = null;
    try { kind = getProvider(slot).kind || null; host = hostOf(resolveBaseUrl(slot, env)); } catch { host = null; }
    const allowed = fixture || !policy.private_corpus ? true : hostAllowed(host, policy.allowed_hosts);
    return { slot, model_id: fixture ? null : safeModelId(slot, env), kind, host, allowed };
  });
  return {
    enforced: policy.private_corpus && !fixture,
    private_corpus: policy.private_corpus,
    allowed_hosts: policy.allowed_hosts,
    fixture,
    slots: rows,
    refused: rows.filter((r) => !r.allowed).map((r) => r.slot),
  };
}

function safeModelId(slot, env) {
  try { return resolveModelId(slot, env) || null; } catch { return null; }
}

/**
 * The check as a gate: throws before any request when a slot would send the private corpus to a
 * host that is not allowed. Returns the check so the caller can record it on the run.
 */
export function assertPrivateCorpus(args) {
  const check = checkPrivateCorpus(args);
  if (check.refused.length) {
    const where = check.slots.filter((r) => !r.allowed).map((r) => `${r.slot} (${r.host || 'endpoint unknown'})`).join(', ');
    throw new Error(
      `private corpus: refusing to send statements to hosted endpoints: ${where}. `
      + `Allowed hosts: ${check.allowed_hosts.join(', ')}. `
      + 'Serve the model on an allowed host (QEDRANK_BASEURL_<SLOT>), or allow the host deliberately: '
      + '"privacy": { "allowedHosts": ["<host>"] } in qedrank.config.json, or --allow-host <host> for one run.',
    );
  }
  return check;
}
