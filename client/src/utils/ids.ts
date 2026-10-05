/**
 * Client ids: crypto.randomUUID is undefined over LAN http, so fall back to getRandomValues. All
 * ids come from here (gate G4). See docs/client-rationale.md#client-ids.
 */

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0')
);

function uuidFromBytes(bytes: Uint8Array): string {
  // RFC 4122 §4.4: set version to 4 and the two high variant bits to 0b10.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = HEX;
  return (
    `${h[bytes[0]]}${h[bytes[1]]}${h[bytes[2]]}${h[bytes[3]]}-` +
    `${h[bytes[4]]}${h[bytes[5]]}-` +
    `${h[bytes[6]]}${h[bytes[7]]}-` +
    `${h[bytes[8]]}${h[bytes[9]]}-` +
    `${h[bytes[10]]}${h[bytes[11]]}${h[bytes[12]]}${h[bytes[13]]}${h[bytes[14]]}${h[bytes[15]]}`
  );
}

/** A v4 UUID. Works in secure and non-secure contexts alike. */
export function newId(): string {
  const cryptoRef = globalThis.crypto;

  if (typeof cryptoRef?.randomUUID === 'function') return cryptoRef.randomUUID();

  if (typeof cryptoRef?.getRandomValues === 'function') {
    return uuidFromBytes(cryptoRef.getRandomValues(new Uint8Array(16)));
  }

  // No Web Crypto at all. Collision risk is real but far better than throwing
  // on the only code path that can create a conversation.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return uuidFromBytes(bytes);
}
