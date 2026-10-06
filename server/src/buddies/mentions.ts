// Pattern: one write path (docs/patterns.md#one-write-path)
//
// Fix-guard (2026-10-06): a Buddy wrote plain `@Wave Simulation Lead` in two root posts. A mention
// exists only in the link form `[@Name](buddy:id)` (MENTION below), so the posts stored
// literally: no chip, no wake, and `post` still reported success. The author never learned it
// had mentioned nobody. This is the ONE canonicalizer at the Buddy post write boundary: the stored
// body is already link-form, so the chip and the wake both come from the one existing regex.
// Guard: `plain @Name mentions` in server/test/buddies-v2.test.ts.

import type { Actor, Channel, Mention, PostKind } from '@unleashd/buddies-core';
import type { MentionPicks } from './events';
import { runConfigOfPick } from './worker-config';

export type Roster = ReadonlyArray<{ id: string; name: string }>;

export type MentionResolution = {
  body: string;
  mentioned: Array<{ id: string; name: string }>;
  /** `@Token`s that matched no Buddy, or more than one: left as plain text. */
  unresolved: string[];
};

// Spans that must never be rewritten: code, and mentions/links that are already canonical.
const PROTECTED = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\[[^\]]*\]\([^)]*\)/g;
// `@` at the start or after a character that cannot make it part of an e-mail/word/path.
const AT = /(^|[^\w@./-])@/g;
const WORD = /\w/;
// `@owner` addresses the human, who is not on the roster; it is not a failed Buddy mention.
const NOT_BUDDIES = new Set(['owner']);

export function resolveMentions(body: string, roster: Roster): MentionResolution {
  // Longest name first, so `@Wave_sim CEO` never half-matches a shorter `Wave_sim`.
  const names = [...roster].sort((a, b) => b.name.length - a.name.length);
  const mentioned = new Map<string, { id: string; name: string }>();
  const unresolved = new Set<string>();

  const plain = (text: string): string => {
    let out = '';
    let last = 0;
    for (const hit of text.matchAll(AT)) {
      const at = (hit.index ?? 0) + hit[1].length;
      if (at < last) continue;
      const rest = text.slice(at + 1);
      const quoted = rest.startsWith('"') ? rest.indexOf('"', 1) : -1;
      const candidate = quoted > 0 ? rest.slice(1, quoted) : null;
      const found = names.find((buddy) => {
        const n = buddy.name.toLowerCase();
        if (candidate !== null) return candidate.toLowerCase() === n;
        return rest.slice(0, n.length).toLowerCase() === n && !WORD.test(rest[n.length] ?? '');
      });
      if (!found) {
        const token = /^[\w-]+/.exec(rest)?.[0];
        if (token && !NOT_BUDDIES.has(token.toLowerCase())) unresolved.add(`@${token}`);
        continue;
      }
      const same = names.filter((b) => b.name.toLowerCase() === found.name.toLowerCase());
      const length = candidate !== null ? quoted + 1 : found.name.length;
      if (same.length > 1) {
        unresolved.add(`@${found.name}`);
        continue;
      }
      mentioned.set(found.id, { id: found.id, name: found.name });
      out += `${text.slice(last, at)}[@${found.name}](buddy:${found.id})`;
      last = at + 1 + length;
    }
    return out + text.slice(last);
  };

  let result = '';
  let cursor = 0;
  for (const span of body.matchAll(PROTECTED)) {
    const start = span.index ?? 0;
    result += plain(body.slice(cursor, start)) + span[0];
    cursor = start + span[0].length;
  }
  result += plain(body.slice(cursor));
  return { body: result, mentioned: [...mentioned.values()], unresolved: [...unresolved] };
}

const MENTION = /\[@([^\]]+)\]\(buddy:([A-Za-z0-9_-]+)\)/g;

export function mentionedBuddyIds(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION)].map((match) => match[2]))];
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/**
 * The Buddies a post wakes, as the crate's `Mention`s: the @mentions of a public or task post, and
 * the DM's Buddies for the owner's plain DM post (a request or an answer starts its own run; a
 * Buddy's DM inform wakes nobody, so two Buddies cannot wake each other). Every writer passes the
 * result in `PostInput.mentions`; the crate writes one `deliver` run per Buddy in the post's own
 * transaction. The owner's chip pick for a Buddy rides its run.
 */
export function wakes(
  channel: Channel,
  author: Actor,
  kind: PostKind,
  body: string,
  picks: MentionPicks
): Mention[] {
  const ids = (() => {
    switch (channel.kind.type) {
      case 'public':
      case 'task':
        return mentionedBuddyIds(body).filter((id) => author.kind !== 'buddy' || author.id !== id);
      case 'direct':
        return author.kind === 'owner' && kind === 'inform'
          ? channel.kind.members.flatMap((member) => (member.kind === 'buddy' ? [member.id] : []))
          : [];
    }
  })();
  return ids.map((buddyId) => {
    const pick = picks.get(buddyId);
    return { buddyId, config: pick && runConfigOfPick(pick) };
  });
}
