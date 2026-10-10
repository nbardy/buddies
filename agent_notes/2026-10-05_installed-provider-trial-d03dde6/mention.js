(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ta = [...document.querySelectorAll('textarea')].find((t) => t.offsetParent !== null);
  if (!ta) return 'no textarea';
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  ta.focus();
  set.call(ta, '@Prod');
  ta.setSelectionRange(5, 5);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  document.dispatchEvent(new Event('selectionchange'));
  await wait(400);
  const option = [...document.querySelectorAll('.channel-composer-picker button')].find((b) => b.textContent.includes('Product Dev'));
  if (!option) return 'no option';
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await wait(400);
  set.call(ta, `${ta.value}what is the status?`);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(400);
  const chip = document.querySelector('.channel-composer-mention');
  return chip ? `${chip.textContent} | disabled=${chip.disabled} | title=${chip.title}` : 'no chip';
})()
