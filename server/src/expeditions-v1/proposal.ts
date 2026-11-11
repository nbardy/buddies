import type { keyed } from '@unleashd/shared';
import { type Clean, previewView } from '../expedition-kernel/launch';

// A clean preview as a proposal shows it: each first-wave call with who does it, in words
// (the card and the tool's reply). `previewView` (expedition-kernel/launch.ts) stays the owner
// HTTP preview's one projection; this adds the one column a reader of a proposal needs.

const seatLabel = (s: keyed.Seat): string => `${s.provider} · ${s.model} · ${s.effort}`;
const whoLabel: { readonly [K in keyed.Who['t']]: (w: Extract<keyed.Who, { t: K }>) => string } = {
  seat: seatLabel,
  buddy: (w) => `buddy ${w.id}`,
};
const WHO: { readonly [K in keyed.Call['t']]: (c: Extract<keyed.Call, { t: K }>) => string } = {
  agent: (c) => (whoLabel[c.by.t] as (w: keyed.Who) => string)(c.by),
  command: () => 'host command',
  ask: () => 'you',
  verdict: () => 'host review',
  leader: () => 'the leader',
};

const whoOf = (asked: Clean['asked'], i: number): string => {
  const { call } = asked[i] as Clean['asked'][number];
  return (WHO[call.t] as (c: keyed.Call) => string)(call);
};

export function proposedPreview(clean: Clean): keyed.ProposedPreview {
  const view = previewView(clean);
  if (view.t !== 'clean') throw new Error('a clean preview projects to a clean view');
  return {
    ...view,
    firstWave: view.firstWave.map((c, i) => ({ ...c, who: whoOf(clean.asked, i) })),
  };
}
