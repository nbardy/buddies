import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { isChannelPreviewFile } from '../buddies/channel-media';
import {
  HOME_DIRECTORY,
  displayPathWithHomeAlias,
  isPathWithin,
  normalizeDirectoryInput,
} from './path-utils';

export interface FilesystemRouteDependencies {
  uploadsDirectory: string;
  isUnderKnownProject: (resolvedPath: string) => boolean;
}

export function registerFilesystemRoutes(
  app: Express,
  dependencies: FilesystemRouteDependencies
): void {
  const { uploadsDirectory, isUnderKnownProject } = dependencies;

  app.get('/api/paths', async (req: Request, res: Response) => {
    const inputPath = typeof req.query.path === 'string' ? req.query.path : '';
    const trimmedInput = inputPath.trim();
    const useHomeAlias = trimmedInput.startsWith('~');
    const visible = (name: string) => !name.startsWith('.');
    if (!trimmedInput) {
      res.json((await subdirectories(HOME_DIRECTORY, visible, (full) => full)) ?? []);
      return;
    }
    const normalizedPath = normalizeDirectoryInput(trimmedInput);
    if (!normalizedPath) {
      res.json([]);
      return;
    }
    const partialSegment = path.basename(normalizedPath);
    const shown = partialSegment.startsWith('.') ? () => true : visible;
    const display = (full: string) => displayPathWithHomeAlias(full, useHomeAlias);
    // A directory lists its children; a partial path lists its parent's matching children.
    const listed = await subdirectories(normalizedPath, shown, display);
    if (listed) {
      res.json(listed);
      return;
    }
    const partial = partialSegment.toLowerCase();
    const matching = (name: string) => shown(name) && name.toLowerCase().startsWith(partial);
    res.json((await subdirectories(path.dirname(normalizedPath), matching, display)) ?? []);
  });

  app.get('/api/validate-path', async (req: Request, res: Response) => {
    const inputPath = typeof req.query.path === 'string' ? req.query.path : '';
    const trimmedInput = inputPath.trim();
    if (!trimmedInput) {
      res.json({ valid: false, error: 'Empty path' });
      return;
    }
    const resolvedPath = path.resolve(normalizeDirectoryInput(trimmedInput));
    try {
      const stats = await fs.promises.stat(resolvedPath);
      res.json(
        stats.isDirectory()
          ? {
              valid: true,
              path: displayPathWithHomeAlias(resolvedPath, trimmedInput.startsWith('~')),
            }
          : { valid: false, error: 'Path is not a directory' }
      );
    } catch {
      res.json({ valid: false, error: 'No matching folder' });
    }
  });

  app.post('/api/mkdir', async (req: Request, res: Response) => {
    const inputPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!inputPath) {
      res.status(400).json({ error: 'Missing path' });
      return;
    }
    const resolvedPath = path.resolve(normalizeDirectoryInput(inputPath));
    try {
      await fs.promises.mkdir(resolvedPath, { recursive: true });
      res.json({
        path: displayPathWithHomeAlias(resolvedPath, inputPath.startsWith('~')),
      });
    } catch (error) {
      console.error('[filesystem] Failed to create directory:', error);
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Failed to create directory' });
    }
  });

  const mayServe = (resolvedPath: string): boolean =>
    isUnderKnownProject(resolvedPath) || isPathWithin(uploadsDirectory, resolvedPath);

  const serve = (res: Response, rawPath: string, preview = false) => {
    const resolved = path.resolve(rawPath);
    if (resolved !== path.normalize(rawPath)) {
      res.status(400).json({ error: 'Path traversal rejected' });
      return;
    }
    if (!mayServe(resolved)) {
      res.status(403).json({ error: 'Path not under any known project' });
      return;
    }
    // Arbitrary uploads must download: HTML/SVG cannot execute with the app's origin.
    // Guard: buddies-v2.test.ts (channel files) checks the direct URL as well as the posted link.
    const pdfPreview = preview && path.extname(resolved).toLowerCase() === '.pdf';
    if (pdfPreview) res.setHeader('X-Content-Type-Options', 'nosniff');
    if (
      isPathWithin(uploadsDirectory, resolved) &&
      !isChannelPreviewFile(resolved) &&
      !pdfPreview
    ) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.download(resolved, (error) => handleSendFileError(error, res, resolved));
      return;
    }
    res.sendFile(resolved, (error) => handleSendFileError(error, res, resolved));
  };

  app.get('/api/files', (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!filePath || !filePath.startsWith('/')) {
      res.status(400).json({ error: 'Absolute path required' });
      return;
    }
    serve(res, filePath, req.query.preview === '1');
  });

  app.get('/api/serve/*', (req: Request, res: Response) => serve(res, `/${req.params[0]}`));
}

/** Up to 20 subdirectories whose names pass `accept`; null when `directory` is no readable dir. */
async function subdirectories(
  directory: string,
  accept: (name: string) => boolean,
  display: (fullPath: string) => string
): Promise<Array<{ name: string; path: string; isDirectory: true }> | null> {
  try {
    if (!(await fs.promises.stat(directory)).isDirectory()) return null;
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && accept(entry.name))
      .slice(0, 20)
      .map((entry) => ({
        name: entry.name,
        path: display(path.join(directory, entry.name)),
        isDirectory: true as const,
      }));
  } catch {
    return null;
  }
}

const CLIENT_HUNG_UP = new Set(['ECONNABORTED', 'EPIPE', 'ECONNRESET']);

function handleSendFileError(error: Error | undefined, response: Response, filePath: string): void {
  if (!error) return;
  const detail = error as Error & { code?: string; status?: number; statusCode?: number };
  const missing = detail.code === 'ENOENT' || detail.status === 404 || detail.statusCode === 404;
  // The client hanging up mid-send is routine, not a failure: <video> fetches metadata then
  // aborts for range requests, and a reload drops in-flight media. Logged as EPIPE /
  // ECONNABORTED stack traces on every restart until 2026-09-28.
  if (CLIENT_HUNG_UP.has(detail.code ?? '')) return;
  if (!missing) console.error('[filesystem] Failed to send file', filePath, error);
  if (response.headersSent) return;
  response.status(missing ? 404 : 500).json({
    error: missing ? 'File not found' : 'Failed to read file',
  });
}
