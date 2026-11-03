import {
  type Act,
  type Attempt,
  type Expedition,
  type FinishReason,
  type Launch,
  type Lesson,
  type Tree,
  attemptResult,
  stateLabel,
} from '@unleashd/shared';

// What the crew is told, and what the owner's chat means (docs/expeditions-lean-design.md §3.4).

/** One Buddy, two seats. Attempt requests (its self-DM) do the work. The owner's chat with it is
 * the expedition's manager seat: a separate conversation, so it answers while an attempt runs
 * (owner posts skip the run cap, runs.rs WAITING_REASON_SQL), and the tool lets only that seat
 * act (host.ts seatOf). Owner 2026-11-03: "No chat log to discuss with the running manager". */
export const CREW_ROLE = [
  "You are an expedition's crew. Each request is one attempt at its goal.",
  'Work only in the workspace the request names and commit on its branch; never push.',
  'Never start Buddies, workers or other agents.',
  'Answer the request when done; its last line is "Lesson: <one sentence>".',
  "In your chat with the owner you are the expedition's manager. Read it with the expedition tool",
  '(status: attempts, lessons, branches, notes) and do what the owner asks with act: pause,',
  'resume, stop, extend, note (guidance for later attempts), verdict, relaunch. The host already',
  'applied a bare pause/resume/stop/extend Nh/pass/fail/note: …; then just confirm. Reply briefly.',
].join('\n');

const sha8 = (sha: string) => sha.slice(0, 8);
const lessonText = (l: Lesson) => (l.t === 'lesson' ? l.text : 'no lesson');

/** Where an attempt's uncommitted work went. Review 2026-11-03: every interrupted attempt was
 * said to be at its salvage ref, which a clean tree never gets; its commits are on its branch. */
const KEPT: { [K in Tree['t']]: (t: Extract<Tree, { t: K }>) => string } = {
  released: (t) => (t.salvageRef === null ? '' : ` · uncommitted work at ${t.salvageRef}`),
  left: (t) => ` · tree left in place (${t.reason})`,
  planned: () => '',
  live: () => '',
  absent: () => '',
};
const kept = (t: Tree) => (KEPT[t.t] as (t: Tree) => string)(t);

/** One prior attempt's line: result, lesson, where its work is. */
function priorLine(x: Expedition, a: Attempt): string {
  const p = a.phase;
  switch (p.t) {
    case 'starting':
    case 'running':
    case 'interrupted':
      return `a${a.n} ${p.t} · branch ${a.branch}${kept(a.tree)}`;
    case 'judging':
    case 'judged': {
      const failing = p.t === 'judged' && p.verdict.t === 'checks' ? p.verdict.runs.at(-1) : null;
      const tail = failing?.outcome.t === 'failed' ? `\n  ${failing.outcome.tail.slice(-600)}` : '';
      const head = `a${a.n} ${attemptResult(a, x.charter.done)} · ${lessonText(p.end.lesson)}`;
      return `${head} · branch ${a.branch} @ ${sha8(p.end.sha)}${kept(a.tree)}${tail}`;
    }
  }
}

export function briefOf(x: Expedition, launch: Launch, a: Attempt, path: string): string {
  const done = x.charter.done;
  const doneText =
    done.t === 'checks'
      ? `${done.checks.map((c) => `- \`${c.join(' ')}\``).join('\n')}\nFiles these name are restored from the base before checking: editing them changes nothing.`
      : 'The owner judges the result.';
  const prior = x.attempts.filter((p) => p.n < a.n).map((p) => priorLine(x, p));
  return [
    `# ${x.charter.name}`,
    x.charter.goal,
    `## DONE WHEN\n${doneText}`,
    `## YOUR WORKSPACE\n${path}\nBRANCH ${a.branch}\nBASE ${launch.baseSha}`,
    `## PRIOR ATTEMPTS\n${prior.join('\n') || 'none'}`,
    'You may merge or cherry-pick earlier attempt branches.',
    `## OWNER NOTES\n${x.notes.map((n) => `- ${n.text}`).join('\n') || 'none'}`,
  ].join('\n\n');
}

/** The answer's last non-empty line, when it reads `Lesson: …`. */
export function lessonOf(body: string): Lesson {
  const last = body.trim().split('\n').at(-1) ?? '';
  const m = /^lesson:\s*(\S.*)$/i.exec(last.trim());
  return m ? { t: 'lesson', text: m[1] } : { t: 'none' };
}

const WORDS: Record<string, Act> = {
  pause: { do: 'pause' },
  resume: { do: 'resume' },
  stop: { do: 'stop' },
};

/** What an owner chat post means to the host: a bare command it applies, or talk for the
 * manager seat to answer (a note only when the manager records one). */
export type Said = { t: 'act'; act: Act } | { t: 'talk' };
const TALK: Said = { t: 'talk' };
const act = (a: Act): Said => ({ t: 'act', act: a });

/** κ for an owner chat message: pause, resume, stop, `extend 2h|30m`, pass, fail (the oldest
 * judging attempt, owner-judged only), `note: <text>`. Anything else is talk. */
export function chatAct(x: Expedition, body: string): Said {
  const said = body
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  const note = /^note:?\s+(\S[\s\S]*)$/i.exec(body.trim());
  if (note) return act({ do: 'note', text: note[1].slice(0, 2000) });
  const extend = /^extend:?\s*(\d+(?:\.\d+)?)\s*(h|m)$/.exec(said);
  if (extend) {
    const hours = Number(extend[1]) / (extend[2] === 'm' ? 60 : 1);
    return hours > 0 && hours <= 72 ? act({ do: 'extend', hours }) : TALK;
  }
  if (said === 'pass' || said === 'fail') {
    const judging = x.attempts.find((a) => a.phase.t === 'judging');
    if (x.charter.done.t !== 'owner' || !judging) return TALK;
    return act({ do: 'verdict', n: judging.n, pass: said === 'pass' });
  }
  return Object.hasOwn(WORDS, said) ? act(WORDS[said]) : TALK;
}

export const judgedLine = (x: Expedition, a: Attempt, lesson: Lesson) =>
  `a${a.n} ${attemptResult(a, x.charter.done)} · Lesson: ${lessonText(lesson)}`;
export const interruptedLine = (a: Attempt) =>
  `a${a.n} interrupted by a server restart; it does not count, and the next attempt is told.`;
export const askVerdictLine = (a: Attempt, sha: string) =>
  `a${a.n} ended @${sha8(sha)} (branch ${a.branch}). Reply pass or fail.`;
export const finishedLine = (x: Expedition, reason: FinishReason) =>
  reason.t === 'passed'
    ? `${stateLabel(x)} · branch expedition/${x.id}/a${reason.n}`
    : stateLabel(x);
