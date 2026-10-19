// Synthetic Inspect logs in the shape the ProofBench harness writes (header + samples with the
// `sessions` store and the `lean_check` score). No private statement text: the "reference" is a
// trivial theorem. Shared by the harness tests.

export function sampleFixture(id, { epoch = 1, value = 'I', errors = ['contains sorry'], ok = false, sessions = null, error = null, comparator = undefined, usage = { in: 1200, out: 300 }, limit = null, submission = 'theorem X : True := trivial', difficulty = null } = {}) {
  const md = {
    ok, errors, files: [`Submission/${id}.lean`], lines: 20, nonblank_lines: 17, proof_lines: ok ? 3 : 0, axioms: ok ? ['propext'] : [], compile_seconds: ok ? 12.5 : null,
    submission_text: submission, submission_files: {},
    comparator: comparator === undefined ? (ok ? { ok: value === 'C', returncode: value === 'C' ? 0 : 1, ran_as: 'verifier', stdout: '', stderr: value === 'C' ? '' : 'statement differs' } : null) : comparator,
    graded_in: 'verifier', sessions_used: (sessions || []).length,
  };
  return {
    id, epoch, input: 'prove', target: id,
    metadata: { name: `Problem ${id}`, difficulty: difficulty ?? (id === 'P003' ? 'Open' : 'Research'), theorem: id, submission: `/opt/proofbench/Submission/${id}.lean`, project_dir: '/opt/proofbench', reference: `theorem ${id} : True := sorry`, sorries: 1, statements_commit: 'abc1234', comparator: true },
    store: { sessions: sessions || [{ session: 1, ended_by: 'submit', output_tokens: 300, total_tokens: 1500, working_seconds: 40, passed: value === 'C', errors: value === 'C' ? [] : errors, counted: true }] },
    scores: value === null ? {} : { lean_check: { value, answer: 'done', explanation: value === 'C' ? 'fast check and comparator passed' : errors.join('; '), metadata: md } },
    events: [{ event: 'model' }, { event: 'tool', function: 'bash' }, { event: 'tool', function: 'bash', error: { message: 'x' } }, { event: 'tool', function: 'submit' }],
    model_usage: usage ? { mock: { input_tokens: usage.in, output_tokens: usage.out, total_tokens: usage.in + usage.out, reasoning_tokens: 0 } } : {},
    total_time: 95.5, working_time: 60.25, limit, error: error ? { message: error } : null, uuid: `u-${id}-${epoch}`,
  };
}

export function logFixture({ model = 'openai-api/qwen/qwen3-30b', samples = [], status = 'success', metadata = {}, config = {} } = {}) {
  return {
    version: 2,
    status,
    eval: {
      run_id: 'run-x', task: 'proofbench', task_id: 't1', created: '2026-10-19T09:00:00+00:00', model, model_generate_config: { max_tokens: 16000 },
      task_args: { ids: samples.map((s) => s.id).join(' '), sandbox: 'docker' },
      metadata: { search: false, network: false, lean_mcp: true, sandbox_type: 'docker', sessions: 2, session_output_tokens: 4000, session_tokens: 1000000, session_working_time: 900, note_tokens: 8000, comparator: true, ...metadata },
      config: { epochs: 1, max_samples: 2, time_limit: 5400, ...config },
      revision: { type: 'git', origin: 'x', commit: 'deadbeef' }, packages: { inspect_ai: '0.3.276' },
    },
    plan: { name: 'plan', steps: [] },
    results: null,
    stats: { started_at: '', completed_at: '' },
    samples,
  };
}

export const MANIFEST = { harness_commit: '2803e81aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', harness_dirty: false, inspect_version: '0.3.276', image_id: 'sha256:842dc0e815ff', lean_toolchain: 'leanprover/lean4:v4.33.1', mathlib_commit: '0df444a', statements_commit: 'abc1234abc1234', sessions: '2', session_output_tokens: '4000', session_working_time: '900', max_tokens: '16000', comparator: 'on', sandbox: 'docker', network: 'false', search: 'false' };
