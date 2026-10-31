import type { Attempt, State } from './ledger';
import { liveWorkers, queued } from './queries';

// The idempotent writes a folded state licenses (pure). The host runs them in order; each carries
// an idempotency key derived from the expedition and the attempt/status id (host.ts).

export type Effect =
  | { t: 'create_crew' }
  /** Build and record the brief (then post it). */
  | { t: 'brief_attempt'; attempt: Attempt }
  /** Post a recorded brief: the replay path after a crash between record and post. */
  | { t: 'post_attempt'; attemptId: string; body: string }
  | { t: 'post_status'; seq: number; text: string }
  | { t: 'post_badge' };

export function pendingEffects(s: State): Effect[] {
  if (s.crew.t === 'pending') return [{ t: 'create_crew' }];
  const badgeEffects: Effect[] = s.badgePost.t === 'pending' ? [{ t: 'post_badge' }] : [];
  const effects: Effect[] = badgeEffects.concat(
    s.statuses
      .filter((x) => x.post.t === 'pending')
      .map((x): Effect => ({ t: 'post_status', seq: x.seq, text: x.text }))
  );
  if (s.run.t === 'finished' || s.run.t === 'paused') return effects;
  for (const attempt of s.attempts)
    if (attempt.phase.t === 'posting')
      effects.push({ t: 'post_attempt', attemptId: attempt.id, body: attempt.phase.body });
  let capacity = s.charter.maxLive - liveWorkers(s).length;
  for (const attempt of queued(s)) {
    if (attempt.spec.kind === 'manager') effects.push({ t: 'brief_attempt', attempt });
    else if (capacity > 0) {
      capacity -= 1;
      effects.push({ t: 'brief_attempt', attempt });
    }
  }
  return effects;
}
