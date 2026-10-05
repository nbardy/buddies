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
import { createReady } from './workspace-home';

const channelsPath = (workspaceId: string) =>
  `/buddies/workspaces/${encodeURIComponent(workspaceId)}/channels`;

// Pattern: one-write-path (docs/patterns.md#one-write-path)
// The ONE "create a workspace" form (owner, #buddies-dev 2026-10-05: the onboarding team step
// and the `/` Folder/Name card were two forms for one job). Onboarding lands on `/` with it open;
// an empty workspace's New Buddy opens it with the folder fixed. Both go workspace → Builder →
// acknowledged send. A new folder may also be created bare ("Just create the workspace").
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
  const [busy, setBusy] = useState<'team' | 'bare' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [builder, setBuilder] = useState<string | null>(null);
  const folderReady = createReady(directory, valid);
  const teamReady = folderReady && description.trim() !== '' && busy === null;
  const selectWorkspace = async () =>
    workspace ??
    (await buddyApi<Workspace>('/api/buddies/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootPath: directory.trim() }),
    }));
  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!teamReady) return;
    setBusy('team');
    setError(null);
    try {
      const selected = await selectWorkspace();
      // Keep the setup chat on a failed send so retry never creates another Builder.
      const conversationId = builder ?? (await createBuddyViaBuilder(selected.id));
      setBuilder(conversationId);
      localStorage.setItem(`${DRAFT_KEY_PREFIX}${conversationId}`, description.trim());
      await sendMessageCommand(conversationId, description.trim(), 'queue');
      localStorage.removeItem(`${DRAFT_KEY_PREFIX}${conversationId}`);
      onStarted?.();
      navigate(`${channelsPath(selected.id)}?dm=${conversationId}`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  const createBare = async () => {
    setBusy('bare');
    setError(null);
    try {
      // The server resolves the folder, reuses its workspace and names it after the folder.
      const selected = await selectWorkspace();
      onStarted?.();
      navigate(channelsPath(selected.id));
    } catch (cause) {
      setError(errorText(cause));
      setBusy(null);
    }
  };
  return (
    <form className="ui-stack onboarding-team" onSubmit={(event) => void start(event)}>
      <fieldset className="ui-stack" disabled={busy !== null || !!builder}>
        <legend>Choose a folder</legend>
        {workspace ? (
          <input aria-label="Choose folder" value={workspace.rootPath} readOnly />
        ) : (
          <PathAutocomplete
            value={directory}
            onChange={(value) => {
              if (!builder && busy === null) setDirectory(value);
            }}
            recentDirectories={recentDirectories}
            placeholder="Search folders or type a path…"
            onValidationChange={setValid}
            autoFocus
          />
        )}
      </fieldset>
      <label className="ui-stack">
        <span>Describe your project and team</span>
        <textarea
          rows={5}
          value={description}
          disabled={busy !== null}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What are you building, and who do you want on the team? Type about your project and what the team should look like, and we’ll kick off your Buddies."
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="onboarding-team-actions">
        {!workspace && (
          <button
            type="button"
            className="onboarding-quiet"
            disabled={!folderReady || busy !== null || !!builder}
            onClick={() => void createBare()}
          >
            {busy === 'bare' ? 'Creating…' : 'Just create the workspace'}
          </button>
        )}
        <button className="onboarding-primary" type="submit" disabled={!teamReady}>
          {busy === 'team' ? 'Starting your team…' : 'Kick off my Buddies'}
        </button>
      </div>
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
