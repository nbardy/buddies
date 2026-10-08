/** Browser guard: confirmation must stay visible while the model list scrolls. */
export function inspectChannelModelPicker() {
  const dialog = document.querySelector('.channel-composer-model');
  const options = dialog?.querySelector('.channel-composer-model-options');
  const actions = dialog?.querySelector('.channel-composer-model-actions');
  if (!dialog || !options || !actions) throw new Error('Model picker did not load');
  const before = actions.getBoundingClientRect();
  const confirm = actions.querySelector('.channel-composer-model-done');
  const button = confirm?.getBoundingClientRect();
  const hit =
    button &&
    document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
  if (!confirm || !hit || !confirm.contains(hit)) {
    throw new Error('Model picker confirmation is covered by another surface');
  }
  const originalScroll = options.scrollTop;
  options.scrollTop = options.scrollHeight;
  const after = actions.getBoundingClientRect();
  options.scrollTop = originalScroll;
  if (
    getComputedStyle(dialog).overflowY !== 'hidden' ||
    before.top < 0 ||
    before.bottom > window.innerHeight ||
    before.left < 0 ||
    before.right > window.innerWidth ||
    Math.abs(before.top - after.top) > 1
  ) {
    throw new Error(
      `Model picker confirmation is clipped or scrolls: ${JSON.stringify({
        top: before.top,
        bottom: before.bottom,
        afterTop: after.top,
        viewportHeight: window.innerHeight,
      })}`
    );
  }
  if (!options.querySelector('input[type="range"]')) {
    throw new Error('Model picker must reuse the thinking slider');
  }
  return { visible: true, optionsScroll: options.scrollHeight > options.clientHeight };
}
