import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLocalFilePath } from '@unleashd/shared';
import { isPathWithin } from '../http/path-utils';

// Channel posts are markdown: previews use ![alt](path), other files use [name](path).
// There is no separate attachments list — the body is the one canonical form.
//
// A post may reference a LOCAL file (a Buddy's screenshot in its worktree, a
// recording in /tmp). Those files vanish when the worktree is removed, so every
// local media reference is copied into the channel's own directory under the
// uploads root when the post is written, and the body is rewritten to point at
// the copy. The copy is content-addressed, so replaying the same post (same
// idempotency key) rewrites to the identical body and stays a replay.
//
// Stored bodies keep ABSOLUTE PATHS, not /api/files URLs: a Buddy reading the
// channel through get_list can open the image with its own file tools, and the
// client maps local paths to /api/files at render time (uploads are served).

export const CHANNEL_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const;
export const CHANNEL_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov'] as const;
// Only these types have previews; every other uploaded type is served as a download.
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...CHANNEL_IMAGE_EXTENSIONS,
  ...CHANNEL_VIDEO_EXTENSIONS,
]);
export function isChannelPreviewFile(source: string): boolean {
  return MEDIA_EXTENSIONS.has(path.extname(source).toLowerCase());
}

export const CHANNEL_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

export type ChannelMediaProblem = {
  reference: string;
  reason: 'missing' | 'too_large' | 'not_a_file';
};

export type CanonicalizedPostBody = { body: string; problems: ChannelMediaProblem[] };

export function channelMediaDirectory(uploadsRoot: string, channelId: string): string {
  // Channel ids are <kind>_<id> (list_, dm_, tc_); anything else never becomes a path segment.
  if (!/^[a-z]+_[0-9a-z_-]+$/i.test(channelId)) throw new Error('Invalid channel id');
  return path.join(uploadsRoot, 'channels', channelId);
}

// `[name](target)` or `![alt](target)` or `![alt](<target with spaces>)`, optional "title".
const FILE_REFERENCE = /(!?)\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(\s+"[^"]*")?\s*\)/g;

type LocalReference = { kind: 'local'; absolutePath: string } | { kind: 'remote' };

function classifyTarget(target: string): LocalReference {
  if (target.startsWith('file://'))
    return { kind: 'local', absolutePath: new URL(target).pathname };
  if (target.startsWith('~/'))
    return { kind: 'local', absolutePath: path.join(os.homedir(), target.slice(2)) };
  // /api/files?path=... and /api/serve/... are already-served app URLs.
  if (isLocalFilePath(target)) return { kind: 'local', absolutePath: target };
  return { kind: 'remote' };
}

function copyIntoChannel(
  source: string,
  directory: string
): { path: string } | { problem: ChannelMediaProblem['reason'] } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    return { problem: 'missing' };
  }
  if (!stat.isFile()) return { problem: 'not_a_file' };
  if (stat.size > CHANNEL_MEDIA_MAX_BYTES) return { problem: 'too_large' };
  const bytes = fs.readFileSync(source);
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  const destination = path.join(
    directory,
    isChannelPreviewFile(source)
      ? `${digest}${path.extname(source).toLowerCase()}`
      : `${digest}_${path.basename(source).replace(/[^a-zA-Z0-9._-]/g, '_')}`
  );
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  return { path: destination };
}

/**
 * Copy every local file reference into the channel directory and rewrite the
 * body to point at the copies. Remote URLs and already-copied files pass
 * through untouched. Problems are returned, never swallowed: every post path
 * (the MCP `post` tool, the owner routes) rejects them so the author can fix
 * its reference.
 */
// Pattern: one-write-path (docs/patterns.md#one-write-path)
// Fix-guard: image-only copying rejected PDF/ZIP shares and left ordinary file links ephemeral.
// buddies-v2.test.ts (channel files) keeps links durable through the upload/post/download boundaries.
function canonicalizePostMedia(
  body: string,
  input: { uploadsRoot: string; channelId: string }
): CanonicalizedPostBody {
  const directory = channelMediaDirectory(input.uploadsRoot, input.channelId);
  const problems: ChannelMediaProblem[] = [];
  const rewritten = body.replace(
    FILE_REFERENCE,
    (whole, embed: string, alt: string, rawTarget: string, title?: string) => {
      const target = rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget;
      const reference = classifyTarget(target);
      if (reference.kind === 'remote') return whole;
      const absolutePath = path.resolve(reference.absolutePath);
      if (isPathWithin(directory, absolutePath)) return whole;
      const copied = copyIntoChannel(absolutePath, directory);
      if ('problem' in copied) {
        problems.push({ reference: target, reason: copied.problem });
        return whole;
      }
      return `${embed && isChannelPreviewFile(copied.path) ? '!' : ''}[${alt}](${copied.path}${title ?? ''})`;
    }
  );
  return { body: rewritten, problems };
}

function describeMediaProblems(problems: readonly ChannelMediaProblem[]): string {
  return problems
    .map((problem) => `${problem.reference} (${problem.reason.replaceAll('_', ' ')})`)
    .join(', ');
}

export class ChannelMediaError extends Error {
  readonly code = 'post_media_invalid';
  constructor(readonly problems: readonly ChannelMediaProblem[]) {
    super(
      `Post media could not be attached: ${describeMediaProblems(problems)}. Attach files up to 50 MB with [name](/absolute/path); images and videos may use ![alt](/absolute/path).`
    );
  }
}

/** Strict form for author-controlled posts: any problem rejects the post. */
export function requireCanonicalPostMedia(
  body: string,
  input: { uploadsRoot: string; channelId: string }
): string {
  const result = canonicalizePostMedia(body, input);
  if (result.problems.length > 0) throw new ChannelMediaError(result.problems);
  return result.body;
}
