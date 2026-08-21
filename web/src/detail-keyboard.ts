type ShortcutTarget = EventTarget & {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selectors: string) => Element | null;
};

const INTERACTIVE_SELECTOR = 'input, textarea, select, button, a, [contenteditable]';

export function shouldIgnoreDrawerShortcut(target: EventTarget | null): boolean {
  const shortcutTarget = target as ShortcutTarget | null;
  if (!shortcutTarget) return false;
  if (shortcutTarget.isContentEditable) return true;
  if (shortcutTarget.closest?.(INTERACTIVE_SELECTOR)) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(shortcutTarget.tagName?.toUpperCase() ?? '');
}
