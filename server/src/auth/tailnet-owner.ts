import { TAILSCALE_CANDIDATES, findCli } from './mobile-access';

// Pattern: sum-types (docs/patterns.md#sum-types)
// Who owns this machine on the tailnet. `tailscale serve` stamps every request
// from a tailnet user with `Tailscale-User-Login` and overwrites a value the
// client sent (verified on tailscale 1.102.2, 2026-10-05: a forged
// `attacker@evil.com` arrived as the owner's login, a forged X-Forwarded-For as
// the real 100.x address). The gate admits that header only when it names this
// owner, so a device someone shares into the tailnet still needs the key.

export type TailnetOwner =
  | { readonly kind: 'known'; readonly login: string }
  | { readonly kind: 'unknown' };

const UNKNOWN: TailnetOwner = { kind: 'unknown' };
const REFRESH_MS = 60_000;

/** κ: `tailscale status --json` → owner. A tagged node has no owning user. */
export async function readTailnetOwner(candidates: readonly string[]): Promise<TailnetOwner> {
  try {
    const cli = await findCli(candidates, 5_000);
    if (cli.kind === 'missing') return UNKNOWN;
    const userId = cli.status.Self?.UserID;
    const login = userId === undefined ? undefined : cli.status.User?.[String(userId)]?.LoginName;
    return login ? { kind: 'known', login } : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

export interface TailnetOwnerWatch {
  /** The last value read; `unknown` until the first read lands. */
  current(): TailnetOwner;
}

/**
 * The gate decides synchronously, so the owner is read in the background and
 * re-read every minute: Tailscale can be signed in or out while the server runs.
 * Until the first read lands, tailnet devices fall back to the key.
 */
export function watchTailnetOwner(
  candidates: readonly string[] = TAILSCALE_CANDIDATES
): TailnetOwnerWatch {
  let owner: TailnetOwner = UNKNOWN;
  const refresh = () => {
    void readTailnetOwner(candidates).then((next) => {
      owner = next;
    });
  };
  refresh();
  setInterval(refresh, REFRESH_MS).unref();
  return { current: () => owner };
}
