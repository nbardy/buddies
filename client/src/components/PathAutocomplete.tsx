import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyMatch, highlightMatches } from '../utils/fuzzyMatch';
import './PathAutocomplete.css';

interface PathEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** A recent directory matched via fuzzy search, with highlight info. */
interface FuzzyDirMatch {
  path: string;
  name: string;
  score: number;
  /** Indices into the display path (~/...) that matched, for highlighting. */
  matches: number[];
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Deduplicated working directories from open conversations. */
  recentDirectories?: readonly string[];
  placeholder?: string;
  className?: string;
  /** When true, the next keystroke clears the input and starts fresh instead of appending. */
  hasPendingDefault?: boolean;
  onClearDefault?: () => void;
  /** Called on Shift+Enter to confirm the current value. */
  onConfirm?: () => void;
  /** Auto-focus the input on mount. */
  autoFocus?: boolean;
  /** Called when path validity changes (exists and is a directory). */
  onValidationChange?: (isValid: boolean) => void;
}

/** Check if a path looks like a valid new directory (absolute or ~/..., with a name after the last /). */
function isCreatablePath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith('/') && !trimmed.startsWith('~')) return false;
  const normalized = trimmed.replace(/\/+$/, '');
  if (!normalized || normalized === '/' || normalized === '~') return false;
  const leaf = normalized.split('/').pop() ?? '';
  if (!leaf || leaf === '.' || leaf === '..' || leaf === '~') return false;
  return true;
}

/**
 * PathAutocomplete - A directory path input with autocomplete suggestions.
 *
 * Features:
 * - Fetches directory listings from /api/paths endpoint
 * - Shows folder icons for directory suggestions
 * - Keyboard navigation (up/down arrows, enter to select, escape to close)
 * - Debounced API calls to avoid excessive requests
 * - Supports ~ expansion for home directory
 */
export function PathAutocomplete({
  value,
  onChange,
  recentDirectories = [],
  placeholder = '/path/to/directory',
  className = '',
  hasPendingDefault = false,
  onClearDefault,
  onConfirm,
  autoFocus = false,
  onValidationChange,
}: Props) {
  const [fsSuggestions, setFsSuggestions] = useState<PathEntry[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isValidPath, setIsValidPath] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const validationDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fsRequestIdRef = useRef(0);
  const validationRequestIdRef = useRef(0);

  // Auto-focus and select all text on mount when autoFocus is true
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [autoFocus]);

  // Fuzzy match recent directories against the current query.
  // Runs synchronously on every render (cheap — typically <20 items).
  const fuzzyMatches: FuzzyDirMatch[] = useMemo(() => {
    const query = value.trim();
    if (query.length === 0) {
      // No query: show all recent directories (no filtering needed)
      return recentDirectories.map((dir) => {
        const name = dir.split('/').filter(Boolean).pop() ?? dir;
        return { path: dir, name, score: 0, matches: [] };
      });
    }
    const results: FuzzyDirMatch[] = [];
    for (const dir of recentDirectories) {
      // Match against the full path — users may type partial folder names anywhere in the path
      const result = fuzzyMatch(query, dir);
      if (result) {
        const name = dir.split('/').filter(Boolean).pop() ?? dir;
        results.push({ path: dir, name, score: result.score, matches: result.matches });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }, [value, recentDirectories]);

  // Determine if the input looks like a filesystem path (starts with / or ~).
  // Non-path queries like "webviewe" skip the filesystem fetch entirely.
  const looksLikePath = value.startsWith('/') || value.startsWith('~');
  const recentDirectorySet = useMemo(() => new Set(recentDirectories), [recentDirectories]);

  // Pull recent directories out of filesystem suggestions (if any) and place them first.
  const orderedFsSuggestions = useMemo(() => {
    const recent: PathEntry[] = [];
    const other: PathEntry[] = [];
    const seen = new Set<string>(fuzzyMatches.map((match) => match.path));

    for (const suggestion of fsSuggestions) {
      if (seen.has(suggestion.path)) {
        continue;
      }
      if (recentDirectorySet.has(suggestion.path)) {
        recent.push(suggestion);
      } else {
        other.push(suggestion);
      }
    }

    return [...recent, ...other];
  }, [fuzzyMatches, fsSuggestions, recentDirectorySet]);

  const shouldShowCreateOption = isCreatablePath(value) && !isValidPath && value.trim().length > 0;
  const shouldShowNoMatchMessage = Boolean(
    value.trim() && fuzzyMatches.length === 0 && orderedFsSuggestions.length === 0 && !isLoading
  );
  const createSuggestionIndex = fuzzyMatches.length + orderedFsSuggestions.length;
  const totalCount =
    fuzzyMatches.length + orderedFsSuggestions.length + (shouldShowCreateOption ? 1 : 0);

  // Fetch filesystem suggestions from the server
  const fetchFsSuggestions = useCallback(async (path: string) => {
    const requestId = ++fsRequestIdRef.current;
    setIsLoading(true);
    const trimmed = path.trim();
    try {
      const response = await fetch(`/api/paths?path=${encodeURIComponent(trimmed)}`);
      if (requestId !== fsRequestIdRef.current) return;
      if (response.ok) {
        const data = (await response.json()) as PathEntry[];
        if (requestId !== fsRequestIdRef.current) return;
        setFsSuggestions(data);
        setSelectedIndex(0);
      } else {
        setFsSuggestions([]);
      }
    } catch {
      if (requestId !== fsRequestIdRef.current) return;
      setFsSuggestions([]);
    } finally {
      if (requestId === fsRequestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Validate if the current path exists and is a directory
  const validatePath = useCallback(
    async (pathToValidate: string) => {
      const trimmed = pathToValidate.trim();
      if (!trimmed) {
        setIsValidPath(true);
        onValidationChange?.(true);
        return;
      }

      const requestId = ++validationRequestIdRef.current;
      try {
        const response = await fetch(`/api/validate-path?path=${encodeURIComponent(trimmed)}`);
        if (requestId !== validationRequestIdRef.current) return;
        const data = (await response.json()) as { valid: boolean; error?: string };
        if (requestId !== validationRequestIdRef.current) return;
        if (!response.ok) {
          setIsValidPath(false);
          onValidationChange?.(false);
          return;
        }
        setIsValidPath(data.valid);
        onValidationChange?.(data.valid);
      } catch {
        if (requestId !== validationRequestIdRef.current) return;
        setIsValidPath(false);
        onValidationChange?.(false);
      }
    },
    [onValidationChange]
  );

  // Debounced validation when value changes
  useEffect(() => {
    if (validationDebounceRef.current) {
      clearTimeout(validationDebounceRef.current);
    }

    validationDebounceRef.current = setTimeout(() => {
      void validatePath(value);
    }, 300);

    return () => {
      if (validationDebounceRef.current) {
        clearTimeout(validationDebounceRef.current);
      }
    };
  }, [value, validatePath]);

  // Debounced fetch when value changes.
  // Skip filesystem fetch for non-path queries (e.g. "webviewe") — only fuzzy matches apply.
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    const trimmed = value.trim();
    const isPath = trimmed.length === 0 || trimmed.startsWith('/') || trimmed.startsWith('~');

    if (!isPath) {
      // Non-path query: clear filesystem suggestions, rely solely on fuzzy matches
      fsRequestIdRef.current += 1;
      setIsLoading(false);
      setFsSuggestions([]);
      return;
    }

    debounceRef.current = setTimeout(() => {
      void fetchFsSuggestions(value);
    }, 150);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [value, fetchFsSuggestions]);

  // Close suggestions when clicking outside.
  // Uses 'click' (not 'mousedown') so that when the dropdown is in normal flow,
  // collapsing it doesn't shift sibling elements (e.g. a Create button) between
  // mousedown and mouseup, which would cause the click to miss the button.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (hasPendingDefault) {
      // First keystroke: clear the pre-filled default, start fresh with just the typed character.
      // inputType='insertText' means a character was typed (not backspace/delete/paste).
      const nativeEvent = e.nativeEvent as InputEvent;
      if (nativeEvent.inputType === 'insertText' && nativeEvent.data) {
        onChange(nativeEvent.data);
        onClearDefault?.();
        setShowSuggestions(true);
        return;
      }
      onClearDefault?.();
    }
    onChange(e.target.value);
    setShowSuggestions(true);
  };

  const handleInputFocus = () => {
    setShowSuggestions(true);
    // Select all text when there's a pending default so user can see what will be replaced
    if (hasPendingDefault) {
      inputRef.current?.select();
    }
    // Fetch filesystem suggestions on focus if we don't have any
    if (fsSuggestions.length === 0 && looksLikePath) {
      void fetchFsSuggestions(value);
    }
  };

  const handleSelectPath = (path: string) => {
    const newValue = path.endsWith('/') ? path : `${path}/`;
    onChange(newValue);
    setShowSuggestions(false);
    inputRef.current?.focus();
    // Immediately fetch contents of the selected directory
    void fetchFsSuggestions(newValue);
  };

  const handleCreateFolder = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      const response = await fetch('/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trimmed }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        path?: string;
      };
      if (!response.ok || !data.path) {
        throw new Error(data.error ?? 'Failed to create directory');
      }
      setIsValidPath(true);
      onValidationChange?.(true);
      handleSelectPath(data.path);
    } catch (err) {
      console.error('Failed to create folder:', err);
    }
  };

  /** Resolve the selected index to a path from the combined list (fuzzy first, then fs). */
  const getSelectedAction = (
    index: number
  ): { type: 'path'; path: string } | { type: 'create' } | null => {
    if (index < fuzzyMatches.length) {
      return { type: 'path', path: fuzzyMatches[index].path };
    }

    const fsIndex = index - fuzzyMatches.length;
    if (fsIndex < orderedFsSuggestions.length) {
      return { type: 'path', path: orderedFsSuggestions[fsIndex].path };
    }

    if (shouldShowCreateOption && index === createSuggestionIndex) {
      return { type: 'create' };
    }

    return null;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Shift+Enter always confirms, regardless of dropdown state
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      onConfirm?.();
      return;
    }

    if (!showSuggestions || totalCount === 0) {
      if (e.key === 'Escape') {
        setShowSuggestions(false);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, totalCount - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter': {
        e.preventDefault();
        const action = getSelectedAction(selectedIndex);
        if (!action) return;
        if (action.type === 'path') {
          handleSelectPath(action.path);
        } else {
          void handleCreateFolder();
        }
        break;
      }
      case 'Escape':
        e.preventDefault();
        setShowSuggestions(false);
        break;
      case 'Tab': {
        const action = getSelectedAction(selectedIndex);
        if (!action) return;
        if (action.type === 'path') {
          e.preventDefault();
          handleSelectPath(action.path);
        } else {
          e.preventDefault();
          void handleCreateFolder();
        }
        break;
      }
    }
  };

  useEffect(() => {
    if (!showSuggestions || totalCount === 0) {
      if (selectedIndex !== 0) {
        setSelectedIndex(0);
      }
      return;
    }

    if (selectedIndex > totalCount - 1) {
      setSelectedIndex(totalCount - 1);
    }
  }, [showSuggestions, totalCount, selectedIndex]);

  // Scroll selected item into view
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedIndex selects a new DOM node via the class applied during render.
  useEffect(() => {
    if (showSuggestions && totalCount > 0) {
      const selectedElement = document.querySelector('.path-suggestion-item.selected');
      selectedElement?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, showSuggestions, totalCount]);

  return (
    <div className={`path-autocomplete ${className}`} ref={containerRef}>
      <div className="path-input-wrapper ui-row">
        <input
          ref={inputRef}
          type="text"
          className={`path-input ui-card ${!isValidPath && value.trim() ? 'path-input-invalid' : ''}`}
          value={value}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        {isLoading && <span className="path-loading-indicator" />}
      </div>
      {showSuggestions && (totalCount > 0 || shouldShowNoMatchMessage) && (
        <div className="path-suggestions ui-card">
          {/* Recent directory fuzzy matches */}
          {fuzzyMatches.map((match, index) => {
            const parts = highlightMatches(match.path, match.matches);
            return (
              <div
                key={`recent:${match.path}`}
                className={`path-suggestion-item ${index === selectedIndex ? 'selected' : ''}`}
                onClick={() => handleSelectPath(match.path)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="path-recent-icon ui-row">
                  <svg
                    aria-hidden="true"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <title>Recent</title>
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </span>
                <span className="path-suggestion-name">{match.name}</span>
                <span className="path-suggestion-path ui-truncate ui-muted">
                  {parts.map((part) =>
                    typeof part === 'string' ? part : <mark key={part.key}>{part.highlighted}</mark>
                  )}
                </span>
              </div>
            );
          })}

          {/* Divider between sections when both have results */}
          {fuzzyMatches.length > 0 && orderedFsSuggestions.length > 0 && (
            <div className="path-section-divider" />
          )}

          {/* Filesystem suggestions */}
          {orderedFsSuggestions.map((suggestion, fsIndex) => {
            const combinedIndex = fuzzyMatches.length + fsIndex;
            return (
              <div
                key={suggestion.path}
                className={`path-suggestion-item ${combinedIndex === selectedIndex ? 'selected' : ''}`}
                onClick={() => handleSelectPath(suggestion.path)}
                onMouseEnter={() => setSelectedIndex(combinedIndex)}
              >
                <span className="path-folder-icon ui-row">
                  <svg
                    aria-hidden="true"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </span>
                <span className="path-suggestion-name">{suggestion.name}</span>
                <span className="path-suggestion-path ui-truncate ui-muted">{suggestion.path}</span>
              </div>
            );
          })}

          {shouldShowNoMatchMessage && (
            <div className="path-no-results ui-muted">No matching folder</div>
          )}

          {shouldShowCreateOption ? (
            <div
              className={`path-suggestion-item path-create-item ${
                createSuggestionIndex === selectedIndex ? 'selected' : ''
              }`}
              onClick={handleCreateFolder}
            >
              <span className="path-create-icon ui-row">
                <svg
                  aria-hidden="true"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  <line x1="12" y1="11" x2="12" y2="17" />
                  <line x1="9" y1="14" x2="15" y2="14" />
                </svg>
              </span>
              <span className="path-suggestion-name">Create folder</span>
              <span className="path-suggestion-path ui-truncate ui-muted">{value.trim()}</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
