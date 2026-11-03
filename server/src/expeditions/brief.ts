import {
  type Act,
  type Attempt,
  type Expedition,
  type FinishReason,
  type Launch,
  type Lesson,
  attemptResult,
  stateLabel,
} from '@unleashd/shared';

// What the crew is told, and what the owner's chat means (docs/expeditions-lean-design.md §3.4).

export const CREW_ROLE = [
  "You are an expedition's crew. Each request is one attempt at its goal.",
  'Work only in the workspace the request names and commit on its branch; never push.',
  'Never start Buddies, workers or other agents.',
  'Answer the request when done; its last line is "Lesson: <one sentence>".',
  'Owner messages in your chat are steering: acknowledge them briefly.',
].join('\n');

const sha8 = (sha: string) => sha.slice(0, 8);
const lessonText = (l: Lesson) => (l.t === 'lesson' ? l.text : 'no lesson');

/** One prior attempt's line: result, lesson, where its work is. */
function priorLine(x: Expedition, a: Attempt): string {
  const p = a.phase;
  switch (p.t) {
    case 'starting':
    case 'running':
    case 'interrupted':
      return `a${a.n} ${p.t} · work kept at refs/salvage/expeditions/${x.id}/a${a.n}`;
    case 'judging':
    case 'judged': {
      const failing = p.t === 'judged' && p.verdict.t === 'checks' ? p.verdict.runs.at(-1) : null;
      const tail = failing?.outcome.t === 'failed' ? `\n  ${failing.outcome.tail.slice(-600)}` : '';
      const head = `a${a.n} ${attemptResult(a, x.charter.done)} · ${lessonText(p.end.lesson)}`;
      return `${head} · branch ${a.branch} @ ${sha8(p.end.sha)}${tail}`;
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

/** κ for an owner chat message. Anything that is not a command is a note for later briefs. */
export function chatAct(x: Expedition, body: string): Act {
  const said = body
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  const note: Act = { do: 'note', text: body.trim().slice(0, 2000) };
  const extend = /^extend:?\s*(\d+(?:\.\d+)?)\s*(h|m)$/.exec(said);
  if (extend) {
    const hours = Number(extend[1]) / (extend[2] === 'm' ? 60 : 1);
    return hours > 0 && hours <= 72 ? { do: 'extend', hours } : note;
  }
  if (said === 'pass' || said === 'fail') {
    const judging = x.attempts.find((a) => a.phase.t === 'judging');
    if (x.charter.done.t !== 'owner' || !judging) return note;
    return { do: 'verdict', n: judging.n, pass: said === 'pass' };
  }
  return WORDS[said] ?? note;
}

export const judgedLine = (x: Expedition, a: Attempt, lesson: Lesson) =>
  `a${a.n} ${attemptResult(a, x.charter.done)} · Lesson: ${lessonText(lesson)}`;
export const askVerdictLine = (a: Attempt, sha: string) =>
  `a${a.n} ended @${sha8(sha)} (branch ${a.branch}). Reply pass or fail.`;
export const finishedLine = (x: Expedition, reason: FinishReason) =>
  reason.t === 'passed'
    ? `${stateLabel(x)} · branch expedition/${x.id}/a${reason.n}`
    : stateLabel(x);
