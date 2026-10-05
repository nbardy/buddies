import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import { type Connection, connectionAtom } from '../atoms/conversations';
import { setSetupDismissed } from '../atoms/ui';
import { useSettingsStore } from '../stores/settingsStore';
import { ColorPalettePicker } from './ColorPalettePicker';
import { UsagePanel } from './UsagePanel';
import './ConfigDropdown.css';

/** The status dot's class and label (`.status-dot.connected` etc. in CSS). */
function connectionLabel({ socket, server }: Connection): string {
  if (server.tag === 'skew') return 'backend reloading';
  if (server.tag === 'outdated') return 'app updated';
  switch (socket.tag) {
    case 'connecting':
      return 'connecting';
    case 'open':
      return 'connected';
    case 'closed':
      return 'disconnected';
  }
}

export function ConfigDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const [showPalettePicker, setShowPalettePicker] = useState(false);
  const [showUsagePanel, setShowUsagePanel] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const settings = useSettingsStore((s) => s.settings);
  const connection = useAtomValue(connectionAtom);
  const label = connectionLabel(connection);
  const dot = connectionLabel({ ...connection, server: { tag: 'unknown' } });

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return (
    <div className="config-dropdown" ref={dropdownRef}>
      <button
        type="button"
        className="config-trigger ui-control ui-row"
        onClick={() => setIsOpen(!isOpen)}
        title="Settings"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <title>Settings</title>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {isOpen && (
        <div className="config-menu">
          <button
            type="button"
            className="config-item ui-control ui-row"
            onClick={() => {
              setSetupDismissed(false);
              setIsOpen(false);
            }}
          >
            <span className="config-item-icon ui-row ui-muted">✓</span>
            <span className="config-item-label">Setup</span>
          </button>
          <div className="config-item ui-control ui-row status-item">
            <span className="config-item-icon ui-row ui-muted">
              <span className={`status-dot ${dot}`} style={{ marginLeft: '4px' }} />
            </span>
            <span className="config-item-label" style={{ textTransform: 'capitalize' }}>
              {label}
            </span>
          </div>
          <button
            type="button"
            className="config-item ui-control ui-row"
            onClick={() => {
              setShowPalettePicker(true);
              setIsOpen(false);
            }}
          >
            <span className="config-item-icon ui-row ui-muted">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <title>Color Palette</title>
                <circle cx="13.5" cy="6.5" r="2.5" />
                <circle cx="6" cy="12" r="2.5" />
                <circle cx="18" cy="12" r="2.5" />
                <circle cx="9" cy="18.5" r="2.5" />
                <circle cx="15" cy="18.5" r="2.5" />
              </svg>
            </span>
            <span className="config-item-label">Color Palette</span>
            <span className="config-item-value ui-muted">{settings.colorPalette}</span>
          </button>
          <button
            type="button"
            className="config-item ui-control ui-row"
            onClick={() => {
              setShowUsagePanel(true);
              setIsOpen(false);
            }}
          >
            <span className="config-item-icon ui-row ui-muted">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <title>Usage</title>
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </span>
            <span className="config-item-label">Usage</span>
          </button>
        </div>
      )}

      {showPalettePicker && <ColorPalettePicker onClose={() => setShowPalettePicker(false)} />}
      {showUsagePanel && <UsagePanel onClose={() => setShowUsagePanel(false)} />}
    </div>
  );
}
