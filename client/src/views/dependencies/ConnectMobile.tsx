import {
  type MobileAccess,
  MobileAccessSchema,
  type MobilePairing,
  MobilePairingSchema,
} from '@unleashd/shared';
import { type ReactNode, useState } from 'react';
import type { SetupSection } from '../../atoms/ui';
import { resource, usePolledFetch } from '../../hooks/usePolledFetch';
import { DependencyCommand, SURFACE, buttonStyle } from './setup-ui';

const ACCESS = resource('/api/mobile-access', async (signal) => {
  const response = await fetch('/api/mobile-access', { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return MobileAccessSchema.parse(await response.json());
});

// Official Tailscale downloads. The phone needs Tailscale too, on the same account.
const INSTALL = {
  computer: 'https://tailscale.com/download',
  iphone: 'https://apps.apple.com/app/tailscale/id1470499037',
  android: 'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
  serve: 'https://tailscale.com/kb/1312/serve',
};

const text: React.CSSProperties = {
  margin: 'var(--sp-4) 0 0',
  color: SURFACE.muted,
  fontSize: 'var(--fs-4)',
  lineHeight: 1.5,
};
const linkStyle: React.CSSProperties = { color: '#8bbcff', textDecoration: 'none' };

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={linkStyle}>
      {children} ↗
    </a>
  );
}

function PhoneApps() {
  return (
    <p style={text}>
      On your phone: <Link href={INSTALL.iphone}>Tailscale for iPhone</Link> ·{' '}
      <Link href={INSTALL.android}>Android</Link>, signed in to the same account.
    </p>
  );
}

// Pattern: sum-types (docs/patterns.md#sum-types) — one handler per state.
function TailscaleMissing() {
  return (
    <>
      <p style={text}>
        Tailscale puts your phone and this computer on one private network, so Buddies never has to
        be on the public internet.
      </p>
      <p style={text}>
        On this computer: <Link href={INSTALL.computer}>Download Tailscale</Link>, open it and sign
        in.
      </p>
      <PhoneApps />
    </>
  );
}

function TailscaleStopped({ state }: { state: string }) {
  return (
    <>
      <p style={text}>
        Tailscale is installed but not connected ({state}). Open Tailscale and sign in, or run:
      </p>
      <DependencyCommand command="tailscale up" label="Connect Tailscale command" />
    </>
  );
}

function AccessKeyMissing({ command, exposed }: { command: string; exposed: boolean }) {
  return (
    <>
      <p style={text}>
        Sign-in is turned off (UNLEASHD_AUTH_DISABLED=1), so a phone would get in without signing
        in. Turn it back on first:
      </p>
      {exposed && (
        <p role="alert" style={{ ...text, color: '#ff9b94' }}>
          Tailscale Serve already forwards to Buddies: every device on your tailnet can open it now,
          with no sign-in.
        </p>
      )}
      <DependencyCommand command={command} label="Turn sign-in on command" />
      <p style={text}>Then restart Buddies. It creates an access key on its first start.</p>
    </>
  );
}

function ServeMissing({ host, command }: { host: string; command: string }) {
  return (
    <>
      <p style={text}>
        Turn on private HTTPS for <strong style={{ color: SURFACE.text }}>{host}</strong>. Only your
        own devices can reach it; it is not on the public internet.
      </p>
      <DependencyCommand command={command} label="Tailscale Serve command" />
      <p style={text}>
        The first time, Tailscale may ask you to enable HTTPS for your tailnet.{' '}
        <Link href={INSTALL.serve}>About Serve</Link>
      </p>
    </>
  );
}

// Pattern: sum-types (docs/patterns.md#sum-types)
type Pairing =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'shown'; readonly pairing: MobilePairing }
  | { readonly kind: 'failed'; readonly message: string };

// A click mints the code (POST), so codes are never minted by the 3s poll.
async function requestPairing(): Promise<Pairing> {
  try {
    const response = await fetch('/api/mobile-access/pairing', { method: 'POST' });
    if (!response.ok) return { kind: 'failed', message: `HTTP ${response.status}` };
    return { kind: 'shown', pairing: MobilePairingSchema.parse(await response.json()) };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

const expiryTime = (expiresAt: number) =>
  new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function PairingQr() {
  const [pairing, setPairing] = useState<Pairing>({ kind: 'idle' });
  const show = () => {
    setPairing({ kind: 'loading' });
    void requestPairing().then(setPairing);
  };
  const button = (label: string) => (
    <button
      type="button"
      style={{ ...buttonStyle, padding: 0, color: '#a6c7ff' }}
      onClick={show}
      disabled={pairing.kind === 'loading'}
    >
      {label}
    </button>
  );
  switch (pairing.kind) {
    case 'idle':
      return <p style={text}>{button('Show QR code')}</p>;
    case 'loading':
      return <p style={text}>{button('Making a code…')}</p>;
    case 'failed':
      return (
        <p style={text}>
          Could not make a code: {pairing.message} {button('Try again')}
        </p>
      );
    case 'shown':
      return (
        <>
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.pairing.svg)}`}
            alt="QR code that signs your phone in"
            style={{
              display: 'block',
              width: 'min(220px, 60vw)',
              marginTop: 'var(--sp-4)',
              background: '#fff',
              borderRadius: 'var(--sp-2)',
            }}
          />
          <p style={text}>
            Scan with your phone's camera. Works once, until {expiryTime(pairing.pairing.expiresAt)}
            . {button('New code')}
          </p>
        </>
      );
  }
}

function Ready({ url, funnel, keyFile }: { url: string; funnel: boolean; keyFile: string }) {
  return (
    <>
      <p style={text}>
        Scan this with your phone (Tailscale connected) to open Buddies already signed in:
      </p>
      <PairingQr />
      <p style={text}>
        Or open the address yourself. Your own Tailscale devices get in without a key:
      </p>
      <DependencyCommand command={url} label="Mobile URL" />
      <p style={text}>Anywhere else, sign in with the access key. To copy it without showing it:</p>
      <DependencyCommand command={keyFile} label="Copy access key command" />
      {funnel && (
        <p role="alert" style={{ ...text, color: '#ff9b94' }}>
          Funnel is on: this URL is reachable from the public internet, and the access key is the
          only thing in the way. Turn it off with <code>tailscale funnel off</code>.
        </p>
      )}
      <PhoneApps />
    </>
  );
}

function Failed({ message }: { message: string }) {
  return <p style={text}>Could not read Tailscale: {message}</p>;
}

/** The key's location as something to run: a file copies silently; an env var is named. */
function keyCopyCommand(key: Extract<MobileAccess, { kind: 'ready' }>['key']): string {
  return key.kind === 'file' ? `pbcopy < ${key.path}` : 'printf %s "$UNLEASHD_AUTH_TOKEN" | pbcopy';
}

function body(access: MobileAccess): ReactNode {
  switch (access.kind) {
    case 'tailscale_missing':
      return <TailscaleMissing />;
    case 'tailscale_stopped':
      return <TailscaleStopped state={access.state} />;
    case 'access_key_missing':
      return <AccessKeyMissing command={access.command} exposed={access.exposed} />;
    case 'serve_missing':
      return <ServeMissing host={access.host} command={access.command} />;
    case 'ready':
      return <Ready url={access.url} funnel={access.funnel} keyFile={keyCopyCommand(access.key)} />;
    case 'failed':
      return <Failed message={access.message} />;
  }
}

const LABEL: Record<MobileAccess['kind'], { text: string; color: string }> = {
  tailscale_missing: { text: 'Needs Tailscale', color: 'var(--warning)' },
  tailscale_stopped: { text: 'Tailscale not connected', color: 'var(--warning)' },
  access_key_missing: { text: 'Needs an access key', color: '#ff9b94' },
  serve_missing: { text: 'One command left', color: 'var(--warning)' },
  ready: { text: 'Ready', color: '#22c55e' },
  failed: { text: 'Check failed', color: '#ff9b94' },
};

// Desktop Setup section: how a phone reaches this app. Mounted only while Setup is
// open; it polls so running a command here flips the state without a reload.
export function ConnectMobile() {
  const access = usePolledFetch(ACCESS, 3_000);

  const label = access.data ? LABEL[access.data.kind] : { text: 'Checking…', color: SURFACE.muted };
  return (
    <section
      id={'connect-mobile' satisfies SetupSection}
      tabIndex={-1}
      aria-labelledby="connect-mobile-title"
      style={{
        padding: 'var(--sp-8) 0',
        borderTop: `1px solid ${SURFACE.border}`,
        outline: 'none',
      }}
    >
      <div
        className="ui-row"
        style={{ justifyContent: 'space-between', gap: 'var(--sp-4)', flexWrap: 'wrap' }}
      >
        <strong
          id="connect-mobile-title"
          style={{ color: SURFACE.text, fontSize: 'var(--fs-6)', fontWeight: 500 }}
        >
          Connect from mobile
        </strong>
        <span style={{ color: label.color, fontSize: 'var(--fs-2)' }}>{label.text}</span>
      </div>
      {access.data ? body(access.data) : <p style={text}>Looking for Tailscale…</p>}
      {(access.kind === 'failed' || access.kind === 'stale') && (
        <p style={text}>Could not load: {access.error.message}</p>
      )}
    </section>
  );
}
