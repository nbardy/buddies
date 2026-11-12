import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { Expeditions } from './engine';

export function registerExpeditionRoutes(app: Express, host: Expeditions) {
  const root = '/api/buddies/expeditions';
  const route = (method: 'get' | 'post', path: string, load: (req: Request) => unknown) => {
    app[method](root + path, async (req: Request, res: Response) => {
      try {
        if (method === 'post') host.allowed();
        res.json(await load(req));
      } catch (error) {
        res.status((error as { status?: number }).status ?? 409).json({ error: String(error) });
      }
    });
  };
  route('get', '', (req) =>
    host.rows().filter((r) => !req.query.workspaceId || r.workspaceId === req.query.workspaceId)
  );
  route('get', '/:id', (req) => host.view(String(req.params.id)));
  route('post', '/launch', (req) => {
    const p = z
      .object({ file: z.string(), hash: z.string(), workspaceId: z.string() })
      .strict()
      .parse(req.body);
    return host.launch(p.file, p.hash, p.workspaceId);
  });
  route('post', '/:id/answer', (req) => {
    const p = z
      .object({ key: z.string(), value: z.union([z.string(), z.boolean()]) })
      .strict()
      .parse(req.body);
    return host.answer(String(req.params.id), p.key, p.value);
  });
}
