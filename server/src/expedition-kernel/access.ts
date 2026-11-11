import { type TurnCapabilities, type TurnGit, capabilityReport } from '@nbardy/agent-cli';
import type { keyed } from '@unleashd/shared';

// What each kind of expedition turn may do: ONE table (CONNECT_PLAN §10 F1, F2). The executor
// derives a turn's capability set here from its call (executor/calls.ts), the Buddy server passes
// it to the harness (agent-cli turns it into each CLI's own flags), and the static gate reports
// it per turn before launch (gates.ts). Until 2026-11-11 a call turn removed only the Buddy tools:
// the first real run's Claude calls ran `--tools default` with permissions bypassed and its Codex
// call `danger-full-access`, every one loading the owner's global instructions.
// Pattern: table-driven (docs/patterns.md#table-driven)

/** One expedition turn, with the paths its limits name. Read roots are directories. */
export type CallTurn =
  /** An agent call with `tree: 'none'` (a seat or a named Buddy): `work` is its cwd. */
  | {
      readonly t: 'call';
      readonly work: string;
      readonly reads: readonly string[];
      readonly web: boolean;
    }
  /** An agent call with `tree: 'checkout'`: `tree` is its worktree and cwd; `git` the metadata a
   * commit on its branch writes outside it (resolved from the made worktree, calls.ts). */
  | {
      readonly t: 'checkout';
      readonly tree: string;
      readonly reads: readonly string[];
      readonly web: boolean;
      readonly git: TurnGit;
    }
  /** A review judge: the judged output's directory and its producer's read roots. */
  | { readonly t: 'judge'; readonly reads: readonly string[] }
  /** A leader wake: the expedition directory to read, its draft folder (inside it) to write. */
  | { readonly t: 'leader'; readonly expDir: string; readonly draft: string };

const WEB = (on: boolean): TurnCapabilities['web'] => (on ? 'on' : 'off');
const set = (
  files: TurnCapabilities['files'],
  web: TurnCapabilities['web'],
  instructions: TurnCapabilities['instructions']
): TurnCapabilities => ({ files, web, instructions, agents: 'off', schedule: 'off', mcp: 'none' });

/**
 * The policy. Every turn: no sub-agents or other agents, no scheduling or remote triggers, no MCP
 * server, never the owner's user-level instructions or memory.
 *
 * | turn     | reads                         | writes          | shell        | web         | instructions |
 * |----------|-------------------------------|-----------------|--------------|-------------|--------------|
 * | call     | input files' dirs, grant.reads| nothing         | none         | grant.web   | none         |
 * | checkout | its worktree, grant.reads     | its worktree +  | in worktree  | grant.web   | the repo's   |
 * |          |                               | its commit meta |              |             |              |
 * | judge    | the judged output, its reads  | nothing         | none         | none        | none         |
 * | leader   | the expedition directory      | its draft folder| none         | none        | none         |
 *
 * A `call` writes nothing, not even its own `work` directory: neither harness needs a writable cwd
 * to answer in its final message.
 */
export const TURN_CAPABILITIES: {
  readonly [K in CallTurn['t']]: (c: Extract<CallTurn, { t: K }>) => TurnCapabilities;
} = {
  call: (c) => set({ t: 'read', roots: c.reads }, WEB(c.web), 'none'),
  checkout: (c) =>
    set(
      { t: 'write', dir: c.tree, reads: c.reads, shell: 'on', git: c.git },
      WEB(c.web),
      'project'
    ),
  judge: (c) => set({ t: 'read', roots: c.reads }, 'off', 'none'),
  leader: (c) =>
    set(
      { t: 'write', dir: c.draft, reads: [c.expDir], shell: 'off', git: { t: 'none' } },
      'off',
      'none'
    ),
};
export const capabilitiesOf = (turn: CallTurn): TurnCapabilities =>
  (TURN_CAPABILITIES[turn.t] as (c: CallTurn) => TurnCapabilities)(turn);

/** The directories a capability set lets a turn read (a judge of its output reads them too). */
export const readsOf = (caps: TurnCapabilities): readonly string[] =>
  READS[caps.files.t](caps.files as never);
const READS: {
  readonly [K in TurnCapabilities['files']['t']]: (
    f: Extract<TurnCapabilities['files'], { t: K }>
  ) => readonly string[];
} = {
  read: (f) => f.roots,
  write: (f) => f.reads,
};

/**
 * Which grants `provider`'s harness enforces for `turn`, as the wire carries it. What it enforces
 * depends on the set's shape, never on its paths, so a preview may name placeholder paths.
 */
export const grantsOf = (provider: string, turn: CallTurn): keyed.TurnGrants =>
  capabilityReport(provider, capabilitiesOf(turn));

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const listed = (paths: readonly string[]) =>
  paths.length === 0 ? 'nothing else' : paths.join(', ');

/**
 * The limits stated once at the head of a call's prompt: what its tools are set to, so a brief
 * never has to say "do not change files". Pure in the set and harness report, the same report the preview uses.
 */
export function limitsText(provider: string, caps: TurnCapabilities): string {
  const report = capabilityReport(provider, caps);
  return [
    `LIMITS (the tools of this turn are set to these where enforced; advisory limits are instructions, not tool restrictions; harness ${provider})`,
    ...(LIMIT_FILES[caps.files.t] as (f: TurnCapabilities['files']) => string[])(caps.files),
    ...(report.shell.t === 'enforced'
      ? [
          `- Shell: ${caps.files.t === 'write' && caps.files.shell === 'on' ? `inside ${caps.files.dir}, with no network` : 'none; use the file tools'}.`,
        ]
      : []),
    ...(report.shell.t === 'advisory'
      ? [`- Shell available on this harness (advisory): ${report.shell.reason}.`]
      : []),
    `- Web: ${caps.web === 'on' ? 'search and fetch are allowed' : 'none'}.`,
    '- No sub-agents or other agents, no scheduled or remote work, no MCP tools.',
    `- Instructions: ${report.instructions.t === 'advisory' ? report.instructions.reason : caps.instructions === 'project' ? "the repository's own instruction files load; nothing user-level" : 'none load beyond this request'}.`,
    ...Object.entries(report).map(
      ([name, enforcement]) =>
        `- ${name}: ${enforcement.t}${enforcement.t === 'advisory' ? `: ${enforcement.reason}` : ''}.`
    ),
    ...(provider === 'claude' && caps.files.t === 'write' && caps.files.shell === 'on'
      ? [
          `- Sandboxed shell commands are pre-approved, including command chains. Stay in ${caps.files.dir}; keep temporary files there. Writes outside the sandbox and shell network access are refused. Claude's built-in safety checks and project/managed deny or ask rules can still refuse a command; report its error, never escape the sandbox.`,
        ]
      : []),
  ].join('\n');
}
const LIMIT_FILES: {
  readonly [K in TurnCapabilities['files']['t']]: (
    f: Extract<TurnCapabilities['files'], { t: K }>
  ) => string[];
} = {
  read: (f) => [
    `- Read: your working directory and ${listed(f.roots)} (${plural(f.roots.length, 'root')}).`,
    '- Write: nothing.',
  ],
  write: (f) => [
    `- Read: ${f.dir} and ${listed(f.reads)}.`,
    `- Write: inside ${f.dir}${f.git.t === 'worktree' ? ` and commit metadata at ${listed(f.git.dirs)}` : ''}.`,
  ],
};
