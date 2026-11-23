// scrollTop can be fractional while scrollHeight and clientHeight are rounded.
export function atConversationEnd(scroll) {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 1;
}

/** Keep the latest answer visible when the composer or window changes height. */
export function createConversationLayout(scroll) {
  let height = scroll.clientHeight;
  let following = atConversationEnd(scroll);
  const trackPosition = () => {
    // A viewport resize may dispatch scroll before ResizeObserver. Preserve the
    // user's pre-resize intent until the new viewport has been handled.
    if (scroll.clientHeight !== height) return;
    following = atConversationEnd(scroll);
  };
  scroll.addEventListener("scroll", trackPosition, { passive: true });
  const observer = new ResizeObserver(() => {
    const nextHeight = scroll.clientHeight;
    if (nextHeight === height) return;
    height = nextHeight;
    if (following) scroll.scrollTop = scroll.scrollHeight;
  });
  observer.observe(scroll);
  return () => {
    observer.disconnect();
    scroll.removeEventListener("scroll", trackPosition);
  };
}
