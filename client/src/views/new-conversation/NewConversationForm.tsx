import {
  type ConversationConfig,
  type ProviderCatalog,
  createDefaultConversationConfig,
} from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type ReactElement, useState } from 'react';
import { connectionAtom, defaultCwdOf, listField } from '../../atoms/conversations';
import { prefsAtom } from '../../atoms/ui';
import { PathAutocomplete } from '../../components/PathAutocomplete';
import { useProviderCatalog } from '../../hooks/useProviderCatalog';
import { normalizeFolderDirectory, shortenHomePath } from '../../utils/directories';
import { ConversationConfigPicker } from '../config/ConversationConfigPicker';
import { type CreateKind, createFromRequest } from './create';
import './NewConversationForm.css';

/**
 * The one new-conversation form: desktop modal (`layout="modal"`) or mobile sheet (`"sheet"`). The
 * container owns title and dismissal; layouts differ only as data (LAYOUT). See docs/client-
 * rationale.md#new-conversation-form.
 */

export type NewConversationLayout = 'modal' | 'sheet';

/**
 * Where the directory field starts. `default` pre-fills latest activity → last
 * used → server cwd and the first keystroke replaces it; `chosen` (a folder
 * group's "+") is the user's own pick and is edited in place.
 */
export type DirectoryStart = { t: 'default' } | { t: 'chosen'; path: string };

interface ConfigSlotProps {
  catalog: ProviderCatalog;
  value: ConversationConfig;
  onChange: (config: ConversationConfig) => void;
}

function ConfigPickerSlot({ catalog, value, onChange }: ConfigSlotProps) {
  return <ConversationConfigPicker value={value} onChange={onChange} catalog={catalog} />;
}

function DefaultConfigSlot({ value }: ConfigSlotProps) {
  return (
    <output className="new-conversation__note">
      Starts on {value.provider} — change the model from the chat header.
    </output>
  );
}

const LAYOUT: Record<
  NewConversationLayout,
  { autoFocus: boolean; quickPicks: number; ConfigSlot: (props: ConfigSlotProps) => ReactElement }
> = {
  modal: { autoFocus: true, quickPicks: 0, ConfigSlot: ConfigPickerSlot },
  sheet: { autoFocus: false, quickPicks: 8, ConfigSlot: DefaultConfigSlot },
};

const ACTION: Record<CreateKind, { label: string; pending: string }> = {
  chat: { label: 'Create', pending: 'Starting…' },
  swarm: { label: 'New Swarm', pending: 'Loading swarm context…' },
};

const KINDS: readonly CreateKind[] = ['chat', 'swarm'];

/** The catalog's first provider is the default (createDefaultConversationConfig's own default until one exists). */
function catalogDefault(catalog: ProviderCatalog): ConversationConfig {
  return createDefaultConversationConfig(catalog.providers[0]?.id ?? 'claude');
}

export function NewConversationForm({
  layout,
  start,
  primary,
  onCreated,
  onBusyChange,
}: {
  layout: NewConversationLayout;
  start: DirectoryStart;
  /** The action Shift+Enter runs and the one drawn as primary. */
  primary: CreateKind;
  onCreated: (conversationId: string) => void;
  /** A swarm create awaits a fetch; the container must not close under it. */
  onBusyChange: (busy: boolean) => void;
}) {
  const recentDirectories = useAtomValue(listField('recentDirs'));
  const latestCwd = useAtomValue(listField('latestCwd'));
  const { lastWorkingDirectory } = useAtomValue(prefsAtom);
  const connection = useAtomValue(connectionAtom);
  const connected = connection.socket.tag === 'open';
  const { catalog, error: catalogError, retry: retryCatalog } = useProviderCatalog();

  const [directory, setDirectory] = useState(() =>
    start.t === 'chosen'
      ? start.path
      : (latestCwd ?? lastWorkingDirectory ?? defaultCwdOf(connection.server) ?? '/')
  );
  const [hasPendingDefault, setHasPendingDefault] = useState(start.t === 'default');
  const [isDirectoryValid, setIsDirectoryValid] = useState(true);
  // Null = the user has not picked yet; the catalog default applies, so a
  // catalog that loads after the form opened is not shadowed by 'claude'.
  const [pickedConfig, setPickedConfig] = useState<ConversationConfig | null>(null);
  const [pending, setPending] = useState<CreateKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { autoFocus, quickPicks, ConfigSlot } = LAYOUT[layout];
  const resolvedDirectory = normalizeFolderDirectory(directory);
  const canCreate =
    catalog !== null &&
    connected &&
    isDirectoryValid &&
    pending === null &&
    directory.trim().length > 0;

  const create = async (kind: CreateKind) => {
    if (!canCreate) return;
    setPending(kind);
    setError(null);
    onBusyChange(true);
    try {
      onCreated(
        await createFromRequest({
          kind,
          workingDirectory: resolvedDirectory,
          config: pickedConfig ?? catalogDefault(catalog),
        })
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(null);
      onBusyChange(false);
    }
  };

  const pickDirectory = (dir: string) => {
    setDirectory(dir);
    setHasPendingDefault(false);
  };

  return (
    <div className="new-conversation ui-stack" data-layout={layout}>
      <div className="new-conversation__label">Working Directory</div>
      <PathAutocomplete
        value={directory}
        onChange={setDirectory}
        recentDirectories={recentDirectories}
        placeholder="Search recent or type a path..."
        className="new-conversation__input"
        hasPendingDefault={hasPendingDefault}
        onClearDefault={() => setHasPendingDefault(false)}
        onConfirm={() => void create(primary)}
        onValidationChange={setIsDirectoryValid}
        autoFocus={autoFocus}
      />
      {/* Sheet only (LAYOUT.quickPicks): tappable recent folders, no keyboard. */}
      {recentDirectories.slice(0, quickPicks).map((dir) => (
        <button
          key={dir}
          type="button"
          className="new-conversation__recent ui-card ui-stack"
          onClick={() => pickDirectory(dir)}
          aria-pressed={dir === resolvedDirectory}
        >
          <span className="ui-truncate">{dir.split('/').filter(Boolean).pop() ?? dir}</span>
          <span className="new-conversation__recent-path ui-truncate ui-muted">
            {shortenHomePath(dir)}
          </span>
        </button>
      ))}
      {catalog ? (
        <ConfigSlot
          catalog={catalog}
          value={pickedConfig ?? catalogDefault(catalog)}
          onChange={setPickedConfig}
        />
      ) : (
        <div className="new-conversation__note" role={catalogError ? 'alert' : 'status'}>
          {catalogError ? (
            <>
              Unable to load providers.{' '}
              <button type="button" onClick={retryCatalog}>
                Retry
              </button>
            </>
          ) : (
            'Loading providers…'
          )}
        </div>
      )}
      {/* Sticky in the sheet: a long recent list must not push the action or the
          error out of reach — a failed submit would report into dead space. */}
      <div className="new-conversation__footer ui-stack">
        {error && (
          <div className="new-conversation__error" role="alert">
            {error}
          </div>
        )}
        {!connected && (
          <output className="new-conversation__note">
            Disconnected from the server — reconnecting.
          </output>
        )}
        <div className="new-conversation__actions ui-row">
          {KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="new-conversation__action ui-control ui-row"
              data-primary={kind === primary}
              onClick={() => void create(kind)}
              disabled={!canCreate}
            >
              {pending === kind ? ACTION[kind].pending : ACTION[kind].label}
              {kind === primary && <kbd className="new-conversation__kbd">⇧↵</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
