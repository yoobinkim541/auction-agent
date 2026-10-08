export type DrawerFocusTrapDecision =
  | { kind: 'none' }
  | { kind: 'container' }
  | { kind: 'item'; index: number };

export function drawerFocusTrapDecision({
  focusableCount,
  activeIndex,
  focusInsideDrawer,
  shiftKey,
}: {
  focusableCount: number;
  activeIndex: number;
  focusInsideDrawer: boolean;
  shiftKey: boolean;
}): DrawerFocusTrapDecision {
  if (focusableCount === 0) return { kind: 'container' };
  if (!focusInsideDrawer || activeIndex < 0) return { kind: 'item', index: shiftKey ? focusableCount - 1 : 0 };
  if (shiftKey && activeIndex === 0) return { kind: 'item', index: focusableCount - 1 };
  if (!shiftKey && activeIndex === focusableCount - 1) return { kind: 'item', index: 0 };
  return { kind: 'none' };
}
