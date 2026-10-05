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

/**
 * κ: `tailscale status --json` → owner. A tagged node has no owning user, and a
 * logged-out node reports none. Throws when the CLI is present but cannot be
 * read (timeout, prose instead of JSON): that says nothing about the owner.
 */
export async function readTailnetOwner(candidates: readonly string[]): Promise<TailnetOwner> {
  const cli = await findCli(candidates, 5_000);
  if (cli.kind === 'missing') return UNKNOWN;
  const userId = cli.status.Self?.UserID;
  const login = userId === undefined ? undefined : cli.status.User?.[String(userId)]?.LoginName;
  return login ? { kind: 'known', login } : UNKNOWN;
}

export interface TailnetOwnerWatch {
  /** The last value read; `unknown` until the first read lands. */
  current(): TailnetOwner;
}

/**
 * The gate decides synchronously, so the owner is read in the background and
 * re-read every minute: Tailscale can be signed in or out while the server runs.
 * Until the first read lands, tailnet devices fall back to the key.
 *
 * A read that fails keeps the last value. Mapping a failure to `unknown` (as
 * first written, 2026-10-05) signed the owner's phone out for up to a minute
 * whenever one `tailscale status` call was slow; the auth test caught it as a
 * 1-in-6 flake. A real sign-out still lands: a logged-out node reads `unknown`.
 */
export function watchTailnetOwner(
  candidates: readonly string[] = TAILSCALE_CANDIDATES,
  onChange: (owner: TailnetOwner) => void = () => {}
): TailnetOwnerWatch {
  let owner: TailnetOwner = UNKNOWN;
  const refresh = () => {
    readTailnetOwner(candidates).then(
      (next) => {
        const changed =
          next.kind !== owner.kind ||
          (next.kind === 'known' && owner.kind === 'known' && next.login !== owner.login);
        owner = next;
        if (changed) onChange(next);
      },
      () => {}
    );
  };
  refresh();
  setInterval(refresh, REFRESH_MS).unref();
  return { current: () => owner };
}
