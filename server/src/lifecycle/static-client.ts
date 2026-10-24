import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

// Vite writes every build output with a content hash in its name under
// `assets/`, so a URL there names one immutable byte sequence forever and the
// browser never needs to revalidate it. Everything else (index.html, the
// manifest, icons) keeps its name across builds and must revalidate, or a
// deploy leaves phones running the previous shell pointing at chunks that no
// longer exist. Before 2026-09-25 express.static sent `max-age=0` for both.
const HASHED_ASSET_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'no-cache';

export function registerStaticClient(app: Express, clientDirectory: string): void {
  const assetsDirectory = path.join(clientDirectory, 'assets') + path.sep;
  // Missing API routes must never receive the SPA's successful HTML response.
  app.use('/api', (_request: Request, response: Response) => {
    response.status(404).json({ error: 'API endpoint unavailable on this server.' });
  });
  app.use(
    express.static(clientDirectory, {
      setHeaders: (response, filePath) => {
        response.setHeader(
          'Cache-Control',
          filePath.startsWith(assetsDirectory) ? HASHED_ASSET_CACHE : REVALIDATE_CACHE
        );
      },
    })
  );
  // A hashed chunk from a previous build is gone after a deploy. Answering its
  // URL with index.html (200, text/html) makes the stale page fail with a
  // MIME-type error instead of a clean 404 the loader can report.
  app.use('/assets', (_request: Request, response: Response) => {
    response.status(404).end();
  });
  // Fix-guard (2026-10-23): the first boot builds client/dist in the background (client-build),
  // so for the first minute index.html does not exist and the catch-all fell into the 500
  // handler, which read as a broken server. Answer 503 + Retry-After with a page that retries.
  // Guard: server/test/static-client-cache.test.ts ("no build yet").
  app.get('*', (_request: Request, response: Response, next: NextFunction) => {
    response.sendFile(
      path.join(clientDirectory, 'index.html'),
      { headers: { 'Cache-Control': REVALIDATE_CACHE } },
      (error: (Error & { code?: string }) | null) => {
        if (!error) return;
        if (error.code !== 'ENOENT') return next(error);
        response
          .status(503)
          .set({ 'Cache-Control': 'no-store', 'Retry-After': '5' })
          .type('html')
          .send(BUILDING_PAGE);
      }
    );
  });
}

const BUILDING_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Client building</title>
<meta http-equiv="refresh" content="5">
<body style="font:16px system-ui;margin:3rem 1rem;color:#333">
<h1 style="font-size:1.2rem">Client building</h1>
<p>The app is still being built. Reload in a few seconds; this page retries on its own.</p>`;
