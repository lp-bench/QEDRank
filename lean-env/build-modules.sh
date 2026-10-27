#!/bin/sh
# Build every module of the project's libraries, or of the dotted prefixes given as arguments
# (e.g. ProofBench.Mathlib_Problems), so that files importing them find their .olean on LEAN_PATH.
# `lake build` alone builds each library's root module and what it imports; a statement library
# whose root imports nothing (ProofBench.lean) would otherwise stay unbuilt. Runs in /project after
# `lake build`. Modules that fail are listed in .qedrank-build-warnings.txt, which the QEDRank
# probe reports; the image is still produced so that the rest can be used and the gap is visible.
set -u
cd /project
prefixes="$*"
if [ -z "$prefixes" ]; then
  for root in *.lean; do
    [ -f "$root" ] || continue
    d="${root%.lean}"
    [ -d "$d" ] && prefixes="$prefixes $d"
  done
fi
: > .qedrank-build-warnings.txt
for p in $prefixes; do
  dir="$(printf '%s' "$p" | tr . /)"
  if [ -d "$dir" ]; then
    mods="$(find "$dir" -name '*.lean' | sed 's#/#.#g; s#\.lean$##' | sort)"
  elif [ -f "$dir.lean" ]; then
    mods="$p"
  elif [ -d ".lake/packages/$p" ]; then
    # A dependency package that the Mathlib cache does not cover (e.g. the Matroid fork): build
    # its default targets, so that files importing it find its .olean.
    echo "qedrank: building dependency package $p"
    lake build "$p/$p" >/dev/null 2>&1 || lake build "$p" >/dev/null 2>&1 || echo "$p (dependency package)" >> .qedrank-build-warnings.txt
    continue
  else
    echo "qedrank: no directory, file or dependency package for module prefix $p" >> .qedrank-build-warnings.txt
    continue
  fi
  n="$(printf '%s\n' "$mods" | grep -c .)"
  echo "qedrank: building $n module(s) under $p"
  # Batches keep the command line short; a failing batch is retried one module at a time so the
  # warning names the modules, not the batch.
  printf '%s\n' "$mods" | xargs -r -n 40 sh -c 'lake build "$@" >/dev/null 2>&1 || for m in "$@"; do lake build "$m" >/dev/null 2>&1 || echo "$m" >> .qedrank-build-warnings.txt; done' sh
done
if [ -s .qedrank-build-warnings.txt ]; then
  echo "qedrank: WARNING: $(grep -c . .qedrank-build-warnings.txt) module(s) did not build:"
  cat .qedrank-build-warnings.txt
else
  rm -f .qedrank-build-warnings.txt
  echo "qedrank: every module built"
fi
exit 0
