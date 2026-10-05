import { useAtomValue } from 'jotai';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sendMessageCommand } from '../../atoms/commands';
import { listField } from '../../atoms/conversations';
import { DRAFT_KEY_PREFIX } from '../../atoms/ui';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { PathAutocomplete } from '../PathAutocomplete';
import { buddyApi, errorText } from './api';
import { createBuddyViaBuilder } from './create-buddy-builder';
import type { Workspace } from './types';

// Pattern: one-write-path (docs/patterns.md#one-write-path)
// Onboarding and empty workspaces use the same workspace → Builder → acknowledged send path.
export function WorkspaceTeamForm({
  workspace,
  onStarted,
}: {
  workspace?: Workspace;
  onStarted?: () => void;
}) {
  const navigate = useNavigate();
  const recentDirectories = useAtomValue(listField('recentDirs'));
  const [directory, setDirectory] = useState(workspace?.rootPath ?? '');
  const [valid, setValid] = useState(!!workspace);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [builder, setBuilder] = useState<string | null>(null);
  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!directory.trim() || !valid || !description.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const selected =
        workspace ??
        (await buddyApi<Workspace>('/api/buddies/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rootPath: directory.trim() }),
        }));
      // Keep the setup chat on a failed send so retry never creates another Builder.
      const conversationId = builder ?? (await createBuddyViaBuilder(selected.id));
      setBuilder(conversationId);
      localStorage.setItem(`${DRAFT_KEY_PREFIX}${conversationId}`, description.trim());
      await sendMessageCommand(conversationId, description.trim(), 'queue');
      localStorage.removeItem(`${DRAFT_KEY_PREFIX}${conversationId}`);
      onStarted?.();
      navigate(`/buddies/workspaces/${selected.id}/channels?dm=${conversationId}`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ui-stack onboarding-team" onSubmit={(event) => void start(event)}>
      <fieldset className="ui-stack" disabled={busy || !!builder}>
        <legend>Choose a folder</legend>
        {workspace ? (
          <input aria-label="Choose folder" value={workspace.rootPath} readOnly />
        ) : (
          <PathAutocomplete
            value={directory}
            onChange={(value) => {
              if (!builder && !busy) setDirectory(value);
            }}
            recentDirectories={recentDirectories}
            placeholder="Search folders or type a path…"
            onValidationChange={setValid}
          />
        )}
      </fieldset>
      <label className="ui-stack">
        <span>Describe your project and team</span>
        <textarea
          rows={5}
          value={description}
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What are you building, and who do you want on the team? Type about your project and what the team should look like, and we’ll kick off your Buddies."
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button
        className="onboarding-primary"
        type="submit"
        disabled={!directory.trim() || !valid || !description.trim() || busy}
      >
        {busy ? 'Starting your team…' : 'Kick off my Buddies'}
      </button>
    </form>
  );
}

export function WorkspaceTeamDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const overview = useBuddyOverview();
  const workspace = overview.data?.find((item) => item.id === workspaceId);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      className="dependencies-dialog onboarding-card"
      ref={dialog}
      onCancel={onClose}
      aria-label="Create your team"
      style={{
        width: 'min(560px, calc(100vw - var(--sp-9)))',
        margin: 'auto',
        color: '#f2f4f8',
        maxHeight: '85dvh',
        padding: 'var(--sp-10)',
      }}
    >
      <div className="ui-stack" style={{ gap: 'var(--sp-7)' }}>
        <div className="ui-row" style={{ justifyContent: 'space-between' }}>
          <h2>Create your team</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close team creator"
            style={{
              border: 'none',
              background: 'transparent',
              color: '#9da8b5',
              fontSize: 'var(--fs-7)',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
        {workspace ? (
          <WorkspaceTeamForm workspace={workspace} onStarted={onClose} />
        ) : (
          <p>{overview.kind === 'failed' ? overview.error.message : 'Loading workspace…'}</p>
        )}
      </div>
    </dialog>
  );
}
