import { z } from 'zod';

// Pattern: one-type-source (docs/patterns.md#one-type-source)
// Pattern: sum-types (docs/patterns.md#sum-types)
// How a phone reaches this app: the first unmet step, or the HTTPS URL. Never an
// invented address — a missing step is a state with the command that fixes it.
export const MobileAccessSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tailscale_missing') }),
  // BackendState other than Running: NeedsLogin, Stopped, Starting, NoState.
  z.object({ kind: z.literal('tailscale_stopped'), state: z.string() }),
  // Auth is open (loopback, no key): Serve forwards from 127.0.0.1, so it would
  // publish the app to the tailnet with no sign-in. `exposed`: it already does.
  z.object({
    kind: z.literal('access_key_missing'),
    command: z.string(),
    exposed: z.boolean(),
  }),
  z.object({ kind: z.literal('serve_missing'), host: z.string(), command: z.string() }),
  z.object({
    kind: z.literal('ready'),
    url: z.string(),
    funnel: z.boolean(),
    // Where the owner's access key lives, for signing in on the phone.
    key: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('file'), path: z.string() }),
      z.object({ kind: z.literal('env') }),
    ]),
  }),
  z.object({ kind: z.literal('failed'), message: z.string() }),
]);
export type MobileAccess = z.infer<typeof MobileAccessSchema>;
