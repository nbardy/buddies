import { type CSSProperties, useMemo } from 'react';
import { resource, usePolledFetch } from '../../hooks/usePolledFetch';
import { type SigilKind, renderSigilUrl } from './sigil/client';
import { EMBLEM_VERSION, emblemGroundCss, workspaceEmblemGenome } from './sigil/emblem';
import { SIGIL_VERSION, backgroundCss, nameGenome } from './sigil/genome';

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

/** Until the render lands (and under react-dom/server) the piece's own ground colour shows. */
function Generated({
  name,
  kind,
  ground,
  className,
}: { name: string; kind: SigilKind; ground: string; className: string }) {
  const source = useMemo(() => sigilResource(name, kind), [name, kind]);
  const { data } = usePolledFetch(source, 0);
  const style: CSSProperties = { background: ground };
  return data ? (
    <img className={className} src={data} alt="" style={style} />
  ) : (
    <span className={className} style={style} aria-hidden="true" />
  );
}

/** Buddy avatar: the glowing kernel style, seeded by its name. */
export function BuddySigil({ name, className }: { name: string; className: string }) {
  const ground = useMemo(() => emblemGroundCss(workspaceEmblemGenome(name)), [name]);
  return <Generated name={name} kind="emblem" ground={ground} className={className} />;
}

/** Workspace icon: the patterned surround with a dark silhouette. */
export function WorkspaceEmblem({ name, className }: { name: string; className: string }) {
  const ground = useMemo(() => backgroundCss(nameGenome(name)), [name]);
  return <Generated name={name} kind="sigil" ground={ground} className={className} />;
}
