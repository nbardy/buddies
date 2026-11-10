# Integrate: put the four features into one app

Your checkout holds the foundation and the first feature, which is already merged. Your inputs
are the commits of the other features. Each passed its own acceptance tests alone, starting from
the tree you are in. Merge them into one commit on which all of them pass together.

## Do

1. Merge each feature commit. Each one touched only its own two folders, so the merges should be
   clean. A conflict means a worker left its fence: do not resolve it quietly; say which commit
   and which file.
2. Run `pnpm typecheck && pnpm accept --all && pnpm build`. This is your judge.
3. Start the app, sign in as the seeded user, and follow every link between features: customer
   to its vehicles, vehicle to its jobs, job to its invoice, and back. A link that one feature
   guessed and another built differently is the usual seam.
4. Read the four features side by side for drift from `docs/CONVENTIONS.md`: a different file
   layout, a different error message shape, a list that pages differently. Fix drift inside the
   feature folders so the four read as one person's work.

## Limits

You may change files only under `server/src/features/` and `client/src/features/`. You may not
change the schema, the shared types, the shell or the acceptance tests. If the features cannot
work together without changing one of those, stop and call `flag` with the exact change needed;
that is a foundation fault and the leader decides what to rerun.

Do not add features, restyle screens or refactor working code that follows the conventions.

## Report

List what you merged, each seam or drift you fixed and in which feature, and anything you chose
not to fix. Commit once.
