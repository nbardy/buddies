// Reconcile committed gitlinks without discarding owner edits or divergent local commits.
// Pattern: one-write-path (docs/patterns.md#one-write-path)
export function reconcileSource(source, run) {
  const options = { cwd: source, encoding: 'utf8', stdio: 'pipe' };
  // An outer A→B merge leaves the nested checkout at A and blocked publishing.
  // Guard: managed source gitlink update test; check edits before changing any checkout.
  const dirty = run(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all'],
    options
  );
  if (dirty.trim())
    throw new Error('Commit local source changes before updating a desktop runtime.');
  run('git', ['diff', '--cached', '--quiet'], options);
  run(
    'git',
    [
      'submodule',
      'foreach',
      '--recursive',
      `
    test -z "$(git status --porcelain --untracked-files=all --ignore-submodules=all)" &&
    git diff --cached --quiet || { echo "Refusing local submodule edits: $displaypath" >&2; exit 1; }
  `,
    ],
    options
  );
  run('git', ['submodule', 'sync', '--recursive'], options);
  // Only move a clean checkout forward from its pinned ancestor. Fetching an object
  // is harmless; a divergent local commit is refused rather than detached and hidden.
  run(
    'git',
    [
      'submodule',
      'foreach',
      '--recursive',
      `
    if test "$(git rev-parse HEAD)" != "$sha1"; then
      git cat-file -e "$sha1^{commit}" 2>/dev/null || git fetch origin "$sha1" || exit 1
      git merge-base --is-ancestor HEAD "$sha1" || {
        echo "Refusing divergent submodule commits: $displaypath" >&2; exit 1;
      }
    fi
  `,
    ],
    options
  );
  run('git', ['submodule', 'update', '--init', '--recursive', '--checkout'], options);
  const remaining = run(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
    options
  );
  if (remaining.trim())
    throw new Error('Source checkout is not clean after reconciling submodules.');
}
