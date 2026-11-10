import type { BuddyEvents } from '../buddies/events';
import { labelled } from '../observability/event-loop-stall';

// How the keyed host notices what happened in the Buddy store (CONNECT_PLAN §1 "Observing
// settlement"): the crate has no "this run settled" or "this thread got a reply" event, only the
// bus's `changed` and `posted`. A burst of those runs ONE pass after `debounceMs`; a backstop pass
// every `backstopMs` covers an event that was missed. Every observer (Buddy calls, owner asks, the
// owner's thread) shares this shape and labels its timers (AGENTS.md: no label-less timers).

export type Observing = { readonly debounceMs: number; readonly backstopMs: number };

/** Start observing; returns the stop. `name` labels both timers (`timer <name>-wake|-backstop`). */
export function observeBuddyEvents(
  events: BuddyEvents,
  timing: Observing,
  name: string,
  pass: () => void
): () => void {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const wake = labelled(`timer ${name}-wake`, () => {
    debounce = null;
    pass();
  });
  const off = events.on((e) => {
    if ((e.kind !== 'changed' && e.kind !== 'posted') || debounce) return;
    debounce = setTimeout(wake, timing.debounceMs);
    debounce.unref();
  });
  const backstop = setInterval(labelled(`timer ${name}-backstop`, pass), timing.backstopMs);
  backstop.unref();
  return () => {
    off();
    if (debounce) clearTimeout(debounce);
    clearInterval(backstop);
  };
}
