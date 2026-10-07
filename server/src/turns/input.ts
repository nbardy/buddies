/**
 * What one turn's input is: who it came from and how it reads to the provider
 * session it reaches. Shared by the queue, the runner and the turn policies.
 */

// Who a turn's input came from. Only 'owner_input' carries owner authority
// (owner controls + the unleashd_owner MCP, see the Buddy turn policy).
// 'buddy_post': a channel-thread seat answering a post ANOTHER BUDDY wrote. It
// keeps the seat's conversation audience (so the seat's provider session
// continues) but never owner authority: until 2026-09-25 (B1) the responder
// sent these as 'owner_input', so Buddy-authored thread text drove turns that
// held configure_team and owner document writes.
export type TurnInput = Readonly<{
  origin: 'owner_input' | 'buddy_post' | 'buddy_message' | 'schedule' | 'unknown';
  inputId: string;
}>;

export type OwnerInput = Readonly<{ origin: 'owner_input'; inputId: string }>;

/**
 * One turn's input worded for the provider session it reaches: `resumed` for a
 * session that already holds this conversation's earlier turns, `fresh` for a
 * new one, which must stand alone. A plain message reads the same either way.
 */
export type SessionRelativePrompt = Readonly<{ resumed: string; fresh: string }>;

export const sameEitherWay = (content: string): SessionRelativePrompt => ({
  resumed: content,
  fresh: content,
});
