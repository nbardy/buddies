(() => {
  const ta = [...document.querySelectorAll('textarea')].find((t) => t.offsetParent !== null);
  if (!ta) return 'no textarea';
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, 'Reply with exactly the word PONG and nothing else. Do not use any tools.');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise((r) => setTimeout(() => {
    const send = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send' && !b.disabled);
    if (!send) return r('no send');
    send.click(); r('sent');
  }, 300));
})()
