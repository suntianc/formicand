const platform =
  globalThis.window?.formicandDesktop?.capabilities?.platform ||
  globalThis.navigator?.userAgentData?.platform ||
  // eslint-disable-next-line no-restricted-syntax -- browsers without UA Client Hints need navigator.platform to label the keyboard modifier.
  globalThis.navigator?.platform ||
  "";
const appleKeyboard = /^(darwin|mac|iphone|ipad|ipod)/i.test(platform);

export function primaryShortcut(key) {
  return appleKeyboard ? `⌘${key}` : `Ctrl + ${key}`;
}

export function labelShellShortcuts(root) {
  for (const button of root.querySelectorAll("[data-shortcut-key]")) {
    const key = button.dataset.shortcutKey;
    button.setAttribute("aria-keyshortcuts", `${appleKeyboard ? "Meta" : "Control"}+${key}`);
    const hint = button.querySelector("kbd");
    if (hint) hint.textContent = primaryShortcut(key);
  }
}
