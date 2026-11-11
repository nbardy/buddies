import './KeyedExpedition.css';
import { useState } from 'react';

/** An act that cannot be undone takes two clicks. */
export function Confirm({ label, sure, run }: { label: string; sure: string; run(): void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className="expedition-button"
      data-tone={armed ? 'danger' : 'plain'}
      onClick={() => (armed ? run() : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {armed ? sure : label}
    </button>
  );
}
