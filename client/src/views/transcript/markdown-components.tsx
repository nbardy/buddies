import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import { FilePreview, getPreviewType, getPreviewableLocalHref } from '../../components/FilePreview';
import type { CopyState } from '../../hooks/useCopyAction';
import { COPY_LABEL, useCopyAction } from '../../hooks/useCopyAction';

/**
 * remark-math recognizes $...$ and $$...$$, while model output commonly uses
 * LaTeX's \(...\) and \[...\] delimiters. Normalize those alternate delimiters
 * before parsing, without changing fenced or inline code.
 */
export function normalizeLatexDelimiters(markdown: string): string {
  const lines = markdown.split('\n');
  let fence: { marker: string; length: number } | null = null;

  return lines
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const markerRun = fenceMatch[1];
        const marker = markerRun[0];
        if (!fence) {
          fence = { marker, length: markerRun.length };
        } else if (marker === fence.marker && markerRun.length >= fence.length) {
          fence = null;
        }
        return line;
      }
      if (fence) return line;

      let result = '';
      let inlineCodeLength = 0;

      for (let i = 0; i < line.length; ) {
        if (line[i] === '`') {
          let runLength = 1;
          while (line[i + runLength] === '`') runLength++;
          if (inlineCodeLength === 0) inlineCodeLength = runLength;
          else if (inlineCodeLength === runLength) inlineCodeLength = 0;
          result += line.slice(i, i + runLength);
          i += runLength;
          continue;
        }

        const delimiter = line.slice(i, i + 2);
        const isUnescapedLatexDelimiter =
          inlineCodeLength === 0 &&
          line[i - 1] !== '\\' &&
          (delimiter === '\\(' ||
            delimiter === '\\)' ||
            delimiter === '\\[' ||
            delimiter === '\\]');

        if (isUnescapedLatexDelimiter) {
          result += delimiter === '\\(' || delimiter === '\\)' ? '$' : '$$';
          i += 2;
          continue;
        }

        result += line[i];
        i++;
      }

      return result;
    })
    .join('\n');
}

// react-markdown v10 calls `code` for fenced and inline code alike; classify into CodeContent and
// dispatch. Multi-line text goes through classifyPathBlock (per line), never getPreviewType. See
// docs/client-rationale.md#code-classification.

// -- Types: what a single line within a multi-line code block can be -----------
type PathBlockEntry =
  | { kind: 'file_path'; path: string; type: 'image' | 'html' | 'video' | 'markdown' }
  | { kind: 'text_line'; text: string };

// -- Types: what the entire <code> element represents -------------------------
type CodeContent =
  | { kind: 'empty' }
  | { kind: 'syntax_highlighted'; className: string }
  | { kind: 'path_block'; entries: PathBlockEntry[] }
  | { kind: 'clickable_url'; url: string }
  | { kind: 'single_file_path'; path: string; type: 'image' | 'html' | 'video' | 'markdown' }
  | { kind: 'plain_code' };

// -- Canonicalization: classify each line independently -----------------------
// Replaces the old parsePathBlock which returned null if ANY line failed.
// Now every line gets a classification — valid paths become file_path entries
// (rendered as FilePreview with hover), everything else becomes text_line
// (rendered as plain monospace text).
function classifyPathBlock(text: string): PathBlockEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const type = getPreviewType(line);
      if (type) return { kind: 'file_path' as const, path: line, type };
      return { kind: 'text_line' as const, text: line };
    });
}

// -- Canonicalization: single entry point for all code content ----------------
// Ordered by specificity: language-tagged > multi-line > single-line patterns.
function classifyCodeContent(text: string | null, className: string | undefined): CodeContent {
  if (!text) return { kind: 'empty' };

  // Language-tagged fenced blocks (className from rehype-highlight, e.g. "language-python").
  // These always pass through to syntax highlighting — never interpreted as paths.
  if (className) return { kind: 'syntax_highlighted', className };

  // Multi-line: fenced code block without language tag.
  if (text.includes('\n')) {
    const entries = classifyPathBlock(text);
    // Upgrade to path_block only if at least one line is a real file path.
    // A block with zero file paths is just plain code.
    if (entries.some((e) => e.kind === 'file_path')) {
      return { kind: 'path_block', entries };
    }
    return { kind: 'plain_code' };
  }

  // Single-line: bare URL in backticks (remark-gfm can't autolink inside code spans).
  if (/^https?:\/\/\S+$/.test(text)) {
    return { kind: 'clickable_url', url: text };
  }

  // Single-line: file path with previewable extension.
  const previewType = getPreviewType(text);
  if (previewType) {
    return { kind: 'single_file_path', path: text, type: previewType };
  }

  return { kind: 'plain_code' };
}

// -- Helpers ------------------------------------------------------------------

function getCodeText(children: unknown): string | null {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) {
    const text = children.map((child) => (typeof child === 'string' ? child : '')).join('');
    return text.length > 0 ? text : null;
  }
  return null;
}

// -- Copy button --------------------------------------------------------------

function CopyGlyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** One glyph per copy state — a Record so a new state is a type error, not a fallthrough. */
export const COPY_GLYPH: Record<CopyState, ReactNode> = {
  idle: (
    <CopyGlyph>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </CopyGlyph>
  ),
  copied: (
    <CopyGlyph>
      <polyline points="20 6 9 17 4 12" />
    </CopyGlyph>
  ),
  failed: (
    <CopyGlyph>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </CopyGlyph>
  ),
};

/**
 * The label is always in the DOM; `.ui-copy-overlay` hides it with CSS so
 * the code-block variant stays icon-only. Keeps the JSX free of a variant prop
 * and keeps the accessible name on `aria-label` either way.
 */
export function CopyButton({ text, className }: { text: string; className: string }) {
  const { state, copy } = useCopyAction(text);
  const label = COPY_LABEL[state];
  return (
    <button
      type="button"
      className={`${className} copy-btn copy-btn--${state}`}
      onClick={copy}
      title={label}
      aria-label={label}
    >
      {COPY_GLYPH[state]}
      <span className="copy-btn__label">{label}</span>
    </button>
  );
}

/**
 * A fenced code block with a hover copy button; chat and channel posts share it.
 * The text comes from the hast node, so highlighting spans never reach the
 * clipboard. It used to come from a `data-raw-code` attribute looked up on
 * props that never carried it, so chat code blocks rendered no button at all.
 */
export function CodeBlockFrame({
  node,
  children,
  frameClassName,
  copyClassName,
  ...preProps
}: ComponentPropsWithoutRef<'pre'> &
  ExtraProps & { frameClassName: string; copyClassName: string }) {
  return (
    <div className={`${frameClassName} ui-copy-host`}>
      <CopyButton
        text={hastText(node).replace(/\n$/, '')}
        className={`${copyClassName} ui-copy-overlay`}
      />
      <pre {...preProps}>{children}</pre>
    </div>
  );
}

// -- Markdown component overrides ---------------------------------------------
function hastText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const candidate = node as { value?: unknown; children?: unknown };
  if (typeof candidate.value === 'string') return candidate.value;
  if (!Array.isArray(candidate.children)) return '';
  return candidate.children.map(hastText).join('');
}

// Factory returns a stable Components object keyed on `workingDirectory` so
// react-markdown doesn't re-mount on every render. Relative file paths are
// resolved against workingDirectory; absolute paths pass through unchanged.
export function makeMarkdownComponents(workingDirectory: string): Components {
  return {
    pre: (props) => (
      <CodeBlockFrame
        frameClassName="message-code-block"
        copyClassName="message-code-copy-btn"
        {...props}
      />
    ),
    a({ node, href, children, ...rest }) {
      const previewableLocalHref = href ? getPreviewableLocalHref(href) : null;
      if (previewableLocalHref) {
        return (
          <FilePreview
            path={previewableLocalHref.path}
            type={previewableLocalHref.type}
            workingDirectory={workingDirectory}
            // Use the source AST text. Rendered `children` may already contain
            // a FilePreview from the code override, which would otherwise put
            // an interactive link inside this link and violate HTML nesting.
            linkLabel={hastText(node) || previewableLocalHref.path}
          />
        );
      }

      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
          {children}
        </a>
      );
    },
    // Thin dispatcher: classify once, switch exhaustively, zero work in cases.
    code({ children, className, ...rest }) {
      const text = getCodeText(children)?.trim() ?? null;
      const content = classifyCodeContent(text, className);

      switch (content.kind) {
        case 'empty':
        case 'plain_code':
          return (
            <code className={className} {...rest}>
              {children}
            </code>
          );

        case 'syntax_highlighted':
          return (
            <code className={content.className} {...rest}>
              {children}
            </code>
          );

        case 'path_block':
          // Mixed block: each line classified independently. file_path entries
          // get FilePreview (icon + hover thumbnail), text_line entries (like
          // "..." or headers) render as plain monospace text. This is the fix
          // for the "many lines as one line" bug — the old parsePathBlock was
          // all-or-nothing: if ANY line wasn't a valid path, the ENTIRE block
          // lost FilePreview functionality.
          return (
            <code className={className} {...rest}>
              {content.entries.map((entry, i) => (
                <span key={i}>
                  {entry.kind === 'file_path' ? (
                    <FilePreview
                      path={entry.path}
                      type={entry.type}
                      workingDirectory={workingDirectory}
                    />
                  ) : (
                    <span className="path-block-text-line ui-muted">{entry.text}</span>
                  )}
                  {i < content.entries.length - 1 && <br />}
                </span>
              ))}
            </code>
          );

        case 'clickable_url':
          {
            const previewableLocalHref = getPreviewableLocalHref(content.url);
            if (previewableLocalHref) {
              return (
                <FilePreview
                  path={previewableLocalHref.path}
                  type={previewableLocalHref.type}
                  workingDirectory={workingDirectory}
                  linkLabel={<code {...rest}>{children}</code>}
                />
              );
            }
          }
          return (
            <a href={content.url} target="_blank" rel="noopener noreferrer">
              <code {...rest}>{children}</code>
            </a>
          );

        case 'single_file_path':
          return (
            <span>
              <FilePreview
                path={content.path}
                type={content.type}
                workingDirectory={workingDirectory}
              />
            </span>
          );
      }
    },
  };
}
