import { type CSSProperties, type ReactNode, useMemo } from 'react';
import { resource, usePolledFetch } from '../../hooks/usePolledFetch';
import { type SigilKind, renderSigilUrl } from './sigil/client';
import { EMBLEM_VERSION, emblemGroundCss, workspaceEmblemGenome } from './sigil/emblem';
import { SIGIL_VERSION, backgroundCss, hash32, nameGenome } from './sigil/genome';
import type { Actor } from './types';

// One render per key per session: the resource cache dedupes concurrent
// mounts, and this memo keeps a WS-reconnect revalidation from re-rendering.
const rendered = new Map<string, Promise<string>>();
const VERSION: Record<SigilKind, number> = { sigil: SIGIL_VERSION, emblem: EMBLEM_VERSION };

export function sigilResource(name: string, kind: SigilKind) {
  const key = `${kind}:v${VERSION[kind]}:${name}`;
  return resource(key, () => {
    const existing = rendered.get(key);
    if (existing) return existing;
    // Never inline: a render blocks the main thread (sigil/client.ts).
    const pending = renderSigilUrl(kind, name);
    rendered.set(key, pending);
    return pending;
  });
}

// Existing theme accents an initial avatar is tinted from; no new palette.
const TONES = [
  'var(--theme-user)',
  'var(--theme-ai)',
  'var(--theme-primary)',
  'var(--theme-warning)',
  'var(--theme-queue)',
  'var(--theme-meta)',
  'var(--theme-success)',
] as const;

/** First letter on a tinted ground: the owner's avatar, and a Buddy's until its sigil renders
 * (the sigil's own ground is a near-black that read as an empty square). */
function Initial({ name, className }: { name: string; className: string }) {
  const style = { '--tone': TONES[hash32(name) % TONES.length] } as CSSProperties;
  return (
    // An SVG, so the letter scales with whatever size the class gives the avatar.
    <svg
      className={`${className} avatar-initial`}
      style={style}
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <text x="5" y="5.2" fontSize="5.6" textAnchor="middle" dominantBaseline="central">
        {name.trim().slice(0, 1).toUpperCase()}
      </text>
    </svg>
  );
}

/** Until the render lands (and under react-dom/server) the piece's own ground colour shows. */
function Generated({
  name,
  kind,
  ground,
  className,
  pending,
}: {
  name: string;
  kind: SigilKind;
  ground: string;
  className: string;
  pending: ReactNode;
}) {
  const source = useMemo(() => sigilResource(name, kind), [name, kind]);
  const { data } = usePolledFetch(source, 0);
  return data ? (
    <img className={className} src={data} alt="" style={{ background: ground }} />
  ) : (
    pending
  );
}

/** Buddy avatar: the glowing kernel style, seeded by its name. */
export function BuddySigil({ name, className }: { name: string; className: string }) {
  const ground = useMemo(() => emblemGroundCss(workspaceEmblemGenome(name)), [name]);
  return (
    <Generated
      name={name}
      kind="emblem"
      ground={ground}
      className={className}
      pending={<Initial name={name} className={className} />}
    />
  );
}

/** A post author's avatar: the owner is an initial, a Buddy its sigil. */
export function AuthorAvatar({
  author,
  name,
  className,
}: {
  author: Actor;
  name: string;
  className: string;
}) {
  switch (author.kind) {
    case 'owner':
      return <Initial name={name} className={className} />;
    case 'buddy':
      return <BuddySigil name={name} className={className} />;
  }
}

/** Workspace icon: the patterned surround with a dark silhouette. */
export function WorkspaceEmblem({ name, className }: { name: string; className: string }) {
  const ground = useMemo(() => backgroundCss(nameGenome(name)), [name]);
  return (
    <Generated
      name={name}
      kind="sigil"
      ground={ground}
      className={className}
      pending={<span className={className} style={{ background: ground }} aria-hidden="true" />}
    />
  );
}
