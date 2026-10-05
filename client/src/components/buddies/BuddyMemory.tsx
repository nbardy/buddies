import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { type UsePolledFetchResult, usePolledFetch } from '../../hooks/usePolledFetch';
import { formatTimeAgo } from '../../utils/time';
import { BuddySoulConflict } from './BuddySoulConflict';
import { ChannelMarkdown } from './ChannelMarkdown';
import { BuddyApiError, buddyApi, buddyWrite, errorText } from './api';
import type { ChannelTask } from './channel-text';
import { readMemoryDoc } from './memory-doc';
import { type SoulMergeBlock, mergeSoulDraft } from './soul-merge';
import type { Doc, DocKind, DocRevision, DocScope } from './types';
import { ActionError, useBuddyAction } from './useBuddyAction';
import './BuddyMemory.css';
import './BuddySoulConflict.css';

/** The server's DocWriteSchema bound (server/src/buddies/routes.ts). */
const DOC_MAX_CHARACTERS = 40_000;

/** A memory doc names no Buddies or Tasks; stable empties keep ChannelMarkdown's memo warm. */
const NO_NAMES: Readonly<Record<string, string>> = {};
const NO_TASKS: ReadonlyMap<string, ChannelTask> = new Map();

/**
 * What a draft is based on. A doc that was never written is revision 0 with no
 * content — the contract's base for a first write, not a default.
 */
type DocBase = { revision: number; content: string };
const baseOf = (doc: Doc | null): DocBase =>
  doc === null ? { revision: 0, content: '' } : { revision: doc.revision, content: doc.content };

type Draft = { base: DocBase; content: string };

const docUrl = (buddyId: string, kind: DocKind) =>
  `/api/buddies/${encodeURIComponent(buddyId)}/docs/${kind}`;

/** Which doc an editor reads and writes, as the route names it (`scope`, `scopeId`, `name`). */
type DocAddress = { scope: DocScope['kind']; scopeId?: string; name: string };
const PORTABLE: DocAddress = { scope: 'buddy', name: '' };

/** A stored doc's address. Buddy scope has no id; the others carry theirs. */
export function addressOf(doc: Doc): DocAddress {
  switch (doc.scope.kind) {
    case 'buddy':
      return { scope: 'buddy', name: doc.name };
    case 'workspace':
      return { scope: 'workspace', scopeId: doc.scope.workspaceId, name: doc.name };
  }
}

const SCOPE_LABEL: { [K in DocScope['kind']]: string } = {
  buddy: 'This Buddy',
  workspace: 'Workspace',
};

export const readUrl = (buddyId: string, kind: DocKind, address: DocAddress) =>
  `${docUrl(buddyId, kind)}?${new URLSearchParams(Object.entries(address)).toString()}`;

/**
 * The three portable docs. `kind` doubles as the section's anchor, so
 * `/buddies/:id/memory#working` lands on working memory (the About card links there).
 */
type PortableKind = Exclude<DocKind, 'shared'>;
const PORTABLE_KINDS: readonly PortableKind[] = ['soul', 'working', 'long_term'];
const PORTABLE_DOC: { [K in PortableKind]: { label: string; hint: string } } = {
  soul: { label: 'Soul', hint: 'Who this Buddy is. New turns read the saved revision.' },
  working: { label: 'Working memory', hint: 'What the Buddy is in the middle of.' },
  long_term: { label: 'Long-term memory', hint: 'What the Buddy keeps across work.' },
};

const updatedAgo = (doc: Doc) => formatTimeAgo(new Date(doc.updatedAt));

/** A doc's saved revisions, newest first; read only while the disclosure is open. */
function DocRevisions({ docId }: { docId: string }) {
  const revisions = usePolledFetch<DocRevision[]>(
    `/api/buddies/docs/${encodeURIComponent(docId)}/revisions`,
    0
  );
  switch (revisions.kind) {
    case 'idle':
    case 'loading':
      return <p className="buddy-panel__empty">Loading history…</p>;
    case 'failed':
      return (
        <p className="buddy-panel__error" role="alert">
          {revisions.error.message}
        </p>
      );
    case 'ready':
    case 'stale':
      return <DocRevisionList revisions={revisions.data} />;
  }
}

export function DocRevisionList({ revisions }: { revisions: readonly DocRevision[] }) {
  return (
    <ol className="buddy-memory__history" aria-label="Revision history">
      {[...revisions].reverse().map((revision) => (
        <li key={revision.revision}>
          <div className="buddy-memory__meta">
            <strong>Revision {revision.revision}</strong>
            <time
              dateTime={revision.createdAt}
              title={new Date(revision.createdAt).toLocaleString()}
            >
              {formatTimeAgo(new Date(revision.createdAt))}
            </time>
            <span>{revision.author}</span>
          </div>
          <p className="buddy-memory__reason">{revision.reason}</p>
          <details>
            <summary>Content</summary>
            <p className="buddy-post-list__body">{revision.content}</p>
          </details>
        </li>
      ))}
    </ol>
  );
}

function DocHistory({ docId }: { docId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="buddy-memory__disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>History</summary>
      {open && <DocRevisions docId={docId} />}
    </details>
  );
}

/** Markdown in the reading measure. */
function Prose({ body }: { body: string }) {
  const message = useMemo(() => ({ t: 'text' as const, text: body }), [body]);
  return (
    <div className="buddy-memory__prose">
      <ChannelMarkdown body={message} buddyNames={NO_NAMES} tasks={NO_TASKS} />
    </div>
  );
}

/** A doc as it reads: its preamble, then each dated entry with the date beside it. */
function DocReading({ content, hint }: { content: string; hint: string }) {
  const reading = readMemoryDoc(content);
  if (!reading.preamble && reading.entries.length === 0) {
    return <p className="buddy-panel__empty">{hint} Nothing written yet.</p>;
  }
  return (
    <>
      {reading.preamble && <Prose body={reading.preamble} />}
      {reading.entries.length > 0 && (
        <ol className="buddy-memory__timeline">
          {reading.entries.map((entry) => (
            <li key={entry.date}>
              <time dateTime={entry.date}>{entry.label}</time>
              <Prose body={entry.body} />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/**
 * The doc's edit form, with optimistic concurrency: a stale base answers 409
 * `[revision_conflict]`, and the draft is three-way merged against the saved text
 * instead of being overwritten or thrown away. Mounted only while editing, so
 * Cancel discards the draft by unmounting it.
 */
function BuddyDocEditor({
  buddyId,
  kind,
  address,
  label,
  hint,
  saved: stored,
  refetch,
  onSaved,
  onCancel,
}: {
  buddyId: string;
  kind: DocKind;
  address: DocAddress;
  label: string;
  hint: string;
  saved: Doc | null;
  refetch: () => Promise<void>;
  onSaved: (notice: string) => void;
  onCancel: () => void;
}) {
  const url = readUrl(buddyId, kind, address);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState<{ saved: DocBase; blocks: SoulMergeBlock[] } | null>(
    null
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const current: Draft = draft ?? { base: baseOf(stored), content: baseOf(stored).content };
  const dirty = current.content !== current.base.content;
  const tooLong = current.content.length > DOC_MAX_CHARACTERS;

  async function save(edited: Draft) {
    setBusy(true);
    setNotice(null);
    try {
      const saved = await buddyWrite(
        'doc.write',
        { buddyId, kind },
        {
          ...address,
          content: edited.content,
          baseRevision: edited.base.revision,
          reason,
        }
      );
      setDraft({ base: baseOf(saved), content: saved.content });
      setReason('');
      await refetch();
      onSaved(`${label} saved as revision ${saved.revision}.`);
    } catch (cause) {
      if (cause instanceof BuddyApiError && cause.status === 409) {
        const saved = baseOf(await buddyApi<Doc | null>(url));
        setDraft(edited);
        setConflict({
          saved,
          blocks: mergeSoulDraft(edited.base.content, edited.content, saved.content),
        });
      } else {
        setNotice(errorText(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {conflict ? (
        <BuddySoulConflict
          label={label}
          maxCharacters={DOC_MAX_CHARACTERS}
          blocks={conflict.blocks}
          baseRevision={current.base.revision}
          savedRevision={conflict.saved.revision}
          onContinue={(content) => {
            setDraft({ base: conflict.saved, content });
            setConflict(null);
            setNotice('Combined draft ready. Review or edit it, then save.');
          }}
          onCancel={() => {
            setConflict(null);
            setNotice(
              'Your original draft is preserved. Saving will check for newer changes again.'
            );
          }}
        />
      ) : (
        <form
          className="buddy-panel__form buddy-memory__editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save(current);
          }}
        >
          <p className="buddy-panel__hint">{hint}</p>
          <textarea
            aria-label={`${label} content`}
            rows={16}
            value={current.content}
            disabled={busy}
            onChange={(event) => setDraft({ ...current, content: event.target.value })}
          />
          <small className="ui-muted" role={tooLong ? 'alert' : undefined}>
            {current.content.length.toLocaleString()} / {DOC_MAX_CHARACTERS.toLocaleString()}{' '}
            characters
          </small>
          <label>
            Reason for change
            <input
              aria-label={`${label} change reason`}
              required
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="buddy-panel__actions">
            <button type="submit" disabled={busy || !dirty || tooLong || !reason.trim()}>
              {busy ? 'Saving…' : `Save ${label.toLowerCase()}`}
            </button>
            <button type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {notice && <output>{notice}</output>}
    </>
  );
}

/** Scroll this section into view when the URL's hash names it, once its doc has loaded. */
function useAnchorScroll(anchor: string | undefined, loaded: boolean) {
  const { hash } = useLocation();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (loaded && anchor !== undefined && hash === `#${anchor}`) {
      ref.current?.scrollIntoView({ block: 'start' });
    }
  }, [anchor, hash, loaded]);
  return ref;
}

/**
 * One doc, read first: rendered markdown with a quiet meta line; Edit swaps in the
 * editor, History opens the revision timeline. Mounted with a Buddy key so a
 * switched Buddy cannot inherit a draft.
 */
function BuddyDoc({
  buddyId,
  kind,
  address,
  label,
  hint,
  anchor,
}: {
  buddyId: string;
  kind: DocKind;
  address: DocAddress;
  label: string;
  hint: string;
  anchor?: string;
}) {
  const doc = usePolledFetch<Doc | null>(readUrl(buddyId, kind, address), 0);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const loaded = doc.kind === 'ready' || doc.kind === 'stale';
  const ref = useAnchorScroll(anchor, loaded);
  const author = doc.data ? readMemoryDoc(doc.data.content).authoredBy : null;

  return (
    <section ref={ref} id={anchor} className="buddy-memory__doc" aria-label={label}>
      <header className="buddy-memory__head ui-row">
        <h3>{label}</h3>
        {doc.data && (
          <span className="buddy-memory__meta">
            <span>Revision {doc.data.revision}</span>
            <time
              dateTime={doc.data.updatedAt}
              title={new Date(doc.data.updatedAt).toLocaleString()}
            >
              updated {updatedAgo(doc.data)}
            </time>
            {author && <span>by {author}</span>}
          </span>
        )}
        {loaded && !editing && (
          <button
            type="button"
            className="buddy-memory__edit"
            onClick={() => {
              setNotice(null);
              setEditing(true);
            }}
          >
            {doc.data ? 'Edit' : 'Write'}
          </button>
        )}
      </header>
      {doc.kind === 'failed' && (
        <p className="buddy-panel__error" role="alert">
          {doc.error.message}
        </p>
      )}
      {doc.kind === 'stale' && (
        <p className="buddy-panel__error" role="alert">
          Could not refresh: {doc.error.message}
        </p>
      )}
      {(doc.kind === 'idle' || doc.kind === 'loading') && (
        <p className="buddy-panel__empty">Loading…</p>
      )}
      {loaded &&
        (editing ? (
          <BuddyDocEditor
            buddyId={buddyId}
            kind={kind}
            address={address}
            label={label}
            hint={hint}
            saved={doc.data}
            refetch={doc.refetch}
            onSaved={(text) => {
              setEditing(false);
              setNotice(text);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <DocReading content={doc.data?.content ?? ''} hint={hint} />
        ))}
      {notice && <output className="ui-muted">{notice}</output>}
      {doc.data && <DocHistory key={doc.data.id} docId={doc.data.id} />}
    </section>
  );
}

/** One index row: the doc's name, revision and age, linking to its section. */
function IndexLink({
  buddyId,
  kind,
  hash,
}: {
  buddyId: string;
  kind: PortableKind;
  hash: string;
}) {
  const doc = usePolledFetch<Doc | null>(readUrl(buddyId, kind, PORTABLE), 0);
  return (
    <li>
      <Link to={`#${kind}`} aria-current={hash === `#${kind}` ? 'location' : undefined}>
        <span>{PORTABLE_DOC[kind].label}</span>
        <small className="ui-muted">
          {doc.data ? `r${doc.data.revision} · ${updatedAgo(doc.data)}` : '—'}
        </small>
      </Link>
    </li>
  );
}

function MemoryIndex({ buddyId, shared }: { buddyId: string; shared: readonly Doc[] | null }) {
  const { hash } = useLocation();
  return (
    <nav className="buddy-memory__index" aria-label="Memory docs">
      <ol>
        {PORTABLE_KINDS.map((kind) => (
          <IndexLink key={kind} buddyId={buddyId} kind={kind} hash={hash} />
        ))}
        <li>
          <Link to="#shared" aria-current={hash === '#shared' ? 'location' : undefined}>
            <span>Shared docs</span>
            <small className="ui-muted">{shared ? shared.length : '—'}</small>
          </Link>
        </li>
      </ol>
    </nav>
  );
}

export function DocCard({ buddyId, doc }: { buddyId: string; doc: Doc }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="buddy-work-disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <strong>{doc.name}</strong>
        <span>
          {SCOPE_LABEL[doc.scope.kind]} · Revision {doc.revision} · updated {updatedAgo(doc)}
        </span>
      </summary>
      {open && (
        <BuddyDoc
          buddyId={buddyId}
          kind={doc.kind}
          address={addressOf(doc)}
          label={doc.name}
          hint={`${SCOPE_LABEL[doc.scope.kind]} doc.`}
        />
      )}
    </details>
  );
}

/** A first write: a shared doc for this Buddy or its whole workspace. */
function NewDocForm({ buddyId, workspaceId }: { buddyId: string; workspaceId: string }) {
  const [shareWith, setShareWith] = useState<'buddy' | 'workspace'>('buddy');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const action = useBuddyAction(async () => {});
  const scope: DocAddress =
    shareWith === 'workspace'
      ? { scope: 'workspace', scopeId: workspaceId, name: name.trim() }
      : { scope: 'buddy', name: name.trim() };
  return (
    <form
      className="buddy-panel__form"
      aria-label="New doc"
      onSubmit={(event) => {
        event.preventDefault();
        void action
          .run('create', () =>
            buddyWrite(
              'doc.write',
              { buddyId, kind: 'shared' },
              {
                ...scope,
                content,
                baseRevision: 0,
                reason: 'Created by the owner',
              }
            )
          )
          .then((ok) => {
            if (!ok) return;
            setName('');
            setContent('');
          });
      }}
    >
      <label>
        Shared with
        <select
          value={shareWith}
          onChange={(event) => setShareWith(event.target.value as typeof shareWith)}
        >
          <option value="buddy">This Buddy</option>
          <option value="workspace">The workspace</option>
        </select>
      </label>
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <textarea
        aria-label="New doc content"
        rows={4}
        maxLength={DOC_MAX_CHARACTERS}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      <button type="submit" disabled={action.busy || !name.trim()}>
        Create
      </button>
      <ActionError state={action.state} />
    </form>
  );
}

/** Shared docs (named, any scope): each opens into its reading view. */
function SharedDocs({
  buddyId,
  workspaceId,
  docs,
}: {
  buddyId: string;
  workspaceId: string;
  docs: UsePolledFetchResult<Doc[]>;
}) {
  return (
    <section id="shared" className="buddy-memory__doc" aria-label="Shared docs">
      <header className="buddy-memory__head ui-row">
        <h3>Shared docs</h3>
      </header>
      {docs.kind === 'failed' && (
        <p className="buddy-panel__error" role="alert">
          {docs.error.message}
        </p>
      )}
      {docs.data?.length === 0 && <p className="buddy-panel__empty">None yet.</p>}
      {docs.data && docs.data.length > 0 && (
        <div>
          {docs.data.map((doc) => (
            <DocCard key={doc.id} buddyId={buddyId} doc={doc} />
          ))}
        </div>
      )}
      <details className="buddy-memory__disclosure">
        <summary>New shared doc</summary>
        <NewDocForm key={buddyId} buddyId={buddyId} workspaceId={workspaceId} />
      </details>
    </section>
  );
}

/**
 * The Buddy's portable docs (soul, working and long-term memory), then its shared docs,
 * behind a compact index. Every doc reads first and keeps its revision history.
 * Detailed notes are agent_notes/*.md files in the workspace.
 */
export function BuddyMemory({ buddyId, workspaceId }: { buddyId: string; workspaceId: string }) {
  const shared = usePolledFetch<Doc[]>(`${docUrl(buddyId, 'shared')}?all=1`, 0);
  return (
    <section className="buddy-memory" aria-label="Memory">
      <MemoryIndex buddyId={buddyId} shared={shared.data} />
      <div className="buddy-memory__docs">
        {PORTABLE_KINDS.map((kind) => (
          <BuddyDoc
            key={`${buddyId}:${kind}`}
            buddyId={buddyId}
            kind={kind}
            address={PORTABLE}
            label={PORTABLE_DOC[kind].label}
            hint={PORTABLE_DOC[kind].hint}
            anchor={kind}
          />
        ))}
        <SharedDocs buddyId={buddyId} workspaceId={workspaceId} docs={shared} />
      </div>
    </section>
  );
}

/** A focused memory tab: the one doc, read first, with its history. */
export function BuddyMemoryDoc({
  buddyId,
  kind,
}: { buddyId: string; kind: 'working' | 'long_term' }) {
  const { label, hint } = PORTABLE_DOC[kind];
  return (
    <section className="buddy-memory buddy-memory--single" aria-label={label}>
      <div className="buddy-memory__docs">
        <BuddyDoc
          key={`${buddyId}:${kind}`}
          buddyId={buddyId}
          kind={kind}
          address={PORTABLE}
          label={label}
          hint={hint}
          anchor={kind}
        />
      </div>
    </section>
  );
}
