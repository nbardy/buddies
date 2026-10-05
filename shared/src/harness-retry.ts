// A Buddy reply or should-reply check that failed can be rerun with a selected model. The
// server refuses any other failure; the client shows the retry button only for these.

/** The harness's usage or session limit (the runtime prefixes "Out of tokens:"). */
export function isOutOfTokensFailure(text: string): boolean {
  return /out_of_tokens|out of tokens/i.test(text);
}

/**
 * Out of tokens, or the harness ending the turn with a provider error (Codex rejecting gpt-5.4 on
 * a ChatGPT account reports `reason: error`, not out of tokens). Anything else — a Buddy that is
 * not active, a missing post — is not the harness's fault and stays plain text.
 */
export function isHarnessRetryFailure(text: string): boolean {
  return (
    isOutOfTokensFailure(text) ||
    // Claude emits a plain weekly-limit provider error rather than out_of_tokens.
    // Guard: ReplyRetry renders the exact weekly-limit envelope (straight/curly apostrophe).
    /you['’]ve hit your weekly limit/i.test(text) ||
    // Gate errors include usage limits, timeouts and config resolution failures. They used to
    // render without recovery. Guard: ReplyRetry renders for failed should-reply checks.
    /could not decide whether to reply/i.test(text) ||
    /Model is unavailable for/i.test(text) ||
    /completed the turn with reason:\s*error/i.test(text) ||
    /not supported when using/i.test(text)
  );
}
