// Pattern: sum types (docs/patterns.md#sum-types). Shown instead of the composer on a group DM:
// one that predates "a DM is one-to-one" (agent_notes/2026-10-06_dm-is-one-to-one-decision.md).
// It stays readable; the crate refuses new posts, so offering a composer would only fail.
export function GroupDmNotice() {
  return (
    <p className="channel-thread-replying ui-muted" role="note">
      This group conversation is read-only. A direct message is one-to-one: continue in a public
      channel, or message each Buddy separately.
    </p>
  );
}
