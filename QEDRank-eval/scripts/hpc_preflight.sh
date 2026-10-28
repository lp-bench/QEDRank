#!/usr/bin/env bash
# Day-one checks on a cluster (or any machine) before running with the Apptainer
# sandbox: what the harness needs from Apptainer, the image, the host and Slurm.
# usage: scripts/hpc_preflight.sh [proofbench-sandbox.sif]
# Prints PASS/FAIL/WARN per check; exit code 1 if any FAIL.
SIF=${1:-proofbench-sandbox.sif}
fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }
warn() { echo "WARN  $1"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "== host"
have apptainer && pass "apptainer $(apptainer --version | awk '{print $3}')" || fail "apptainer not on PATH"
have python3 && pass "python3 $(python3 --version | awk '{print $2}')" || fail "python3 missing"
if python3 -c "import inspect_ai, inspect_apptainer" 2>/dev/null; then
  pass "inspect_ai $(python3 -c 'import inspect_ai; print(inspect_ai.__version__)') + inspect_apptainer importable"
else
  warn "inspect_ai/inspect_apptainer not importable from this python (run scripts/setup.sh, then . .venv/bin/activate)"
fi
have sbatch && pass "slurm: $(sinfo -h -o '%P %D %c %m' 2>/dev/null | head -n 3 | tr '\n' ';')" || warn "no slurm (fine on a workstation)"
have nvidia-smi && pass "GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -n 2 | tr '\n' ';')" || warn "no nvidia-smi on this node (model serving needs a GPU node)"
df -h . | awk 'NR==2{print "      disk here: " $4 " free"}'
echo "      scratch dir for sandboxes: ${TMPDIR:-/tmp}"
[ "$(stat -f -c %T "${TMPDIR:-/tmp}")" = "nfs" ] && warn "TMPDIR is on NFS: slow; point TMPDIR at node-local scratch" || true

echo "== image $SIF"
if [ ! -f "$SIF" ]; then fail "no image at $SIF"; echo "FAILS: $fails"; exit 1; fi
pass "size $(du -h "$SIF" | cut -f1)"
A="apptainer exec --containall --cleanenv --writable-tmpfs"
$A "$SIF" /bin/true 2>/dev/null && pass "exec with --containall --cleanenv --writable-tmpfs" || fail "basic exec fails"
if $A --net --network none "$SIF" /bin/true 2>/dev/null; then pass "--net --network none (network namespace allowed for users)"
else fail "--net --network none refused: site disallows user network namespaces; run with network=host and tell the paper the sandbox was not offline"; fi
T=$(mktemp -d); echo hi > "$T/in"
if $A --bind "$T:/mnt/scratch" "$SIF" sh -c 'cat /mnt/scratch/in >/dev/null && touch /mnt/scratch/out' 2>/dev/null && [ -f "$T/out" ]; then pass "user bind mount read/write"
else fail "bind mount of a host directory fails (user bind control off?)"; fi
rm -rf "$T"
if $A "$SIF" sh -c 'env | grep -qiE "KEY|TOKEN|SECRET"' 2>/dev/null; then fail "host environment leaks into the container"; else pass "no host environment inside (--cleanenv)"; fi
n=$($A "$SIF" sh -c 'ls /proc | grep -c "^[0-9]"' 2>/dev/null); [ "${n:-99}" -le 5 ] && pass "own PID namespace ($n processes visible)" || warn "PID namespace not isolated ($n processes visible)"
mb=$($A "$SIF" sh -c 'dd if=/dev/zero of=/var/tmp/x bs=1M count=512 2>&1 | tail -n1; rm -f /var/tmp/x' 2>/dev/null | grep -oE '^[0-9]+ bytes' | awk '{printf "%d", $1/1048576}')
if [ "${mb:-0}" -ge 256 ]; then pass "writable-tmpfs overlay holds ${mb} MB (needed: Lean build outputs of a submission)"
else warn "writable-tmpfs overlay only ${mb:-0} MB (site 'sessiondir max size'); add the project's .lake/build to the writable binds"; fi
$A "$SIF" sh -c 'cd /opt/proofbench && lake env lean --version' >/dev/null 2>&1 && pass "lake + lean run in the image ($($A "$SIF" sh -c 'cd /opt/proofbench && lake env lean --version' 2>/dev/null))" || fail "lake env lean fails in the image"
$A "$SIF" sh -c 'cd /opt/proofbench && lake env lean ProofBench/PROBLEMS/P109/P109.lean' >/dev/null 2>&1 && pass "a statement file compiles from the cached oleans" || warn "P109 statement does not compile (missing from this image, or oleans stale)"
$A "$SIF" /opt/venv/bin/lean-lsp-mcp --help >/dev/null 2>&1 && pass "lean-lsp-mcp present" || fail "lean-lsp-mcp missing"
if $A "$SIF" sh -c 'test -x /opt/verifier/bin/comparator && test -x /opt/verifier/bin/landrun' 2>/dev/null; then
  # landrun wants the newest Landlock ABI unless --best-effort (Comparator's mode);
  # any ABI >= 1 gives filesystem restrictions, which is what matters offline.
  err=$($A "$SIF" /opt/verifier/bin/landrun --rox / -- /bin/true 2>&1 >/dev/null); rc=$?
  abi=$(echo "$err" | grep -oE "Got Landlock ABI v[0-9]+" | grep -oE "[0-9]+$")
  if [ "$rc" = 0 ]; then pass "Landlock: full support (landrun sandbox engages)"
  elif [ -n "$abi" ] && [ "$abi" -ge 1 ] && $A "$SIF" /opt/verifier/bin/landrun --best-effort --rox / -- /bin/true >/dev/null 2>&1; then
    pass "Landlock ABI v$abi: Comparator's sandbox engages in best-effort mode (filesystem restrictions active)"
  else fail "Landlock unavailable in this kernel (LSM not enabled?): Comparator would run unsandboxed"; fi
else warn "verifier binaries missing from the image (COMPARATOR=off only)"; fi
$A "$SIF" /usr/bin/timeout 1 sleep 0 >/dev/null 2>&1 && pass "timeout binary (inspect-apptainer needs it)" || fail "/usr/bin/timeout missing in the image"
echo "FAILS: $fails"
[ "$fails" -eq 0 ]
