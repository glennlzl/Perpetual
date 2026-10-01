import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** A node that takes focus: an element, or a stand-in with focus. */
export interface Focusable { focus(options?: FocusOptions): void }
/** A focus candidate, read without assuming it is an element: detached, disabled or inert ones are skipped. */
export interface FocusTarget { isConnected?: boolean; disabled?: boolean; focus?(options?: FocusOptions): void; closest?(selectors: string): unknown }
/** An element that may have opened a dialog; a menu item names its menu. */
export interface OpenerNode extends FocusTarget { getAttribute(name: string): string | null; closest?(selectors: string): { id?: string } | null }
/** The document fields dialogOpener reads. */
export interface OpenerDocument { body: unknown; activeElement: OpenerNode | null; querySelectorAll(selectors: string): Iterable<OpenerNode> }

// Switching between the journey grid and focus mode unmounts the control that was used,
// so keyboard focus follows the journey: into the focused view, then back to its card.
export function createViewFocus() {
  const cards = new Map<string | undefined, Focusable>(), refs = new Map<string, (node: Focusable | null) => void>();
  let heading: Focusable | null = null, target: { heading?: boolean; id?: string } | null = null;
  return {
    heading: (node: Focusable | null) => { heading = node; },
    card(id: string) {
      if (!refs.has(id)) refs.set(id, node => { if (node) cards.set(id, node); else cards.delete(id); });
      return refs.get(id)!;
    },
    enter() { target = { heading: true }; },
    leave(id: string) { target = { id }; },
    // Runs after the new view commits; only a user switch moves focus.
    settle() {
      const node = target?.heading ? heading : cards.get(target?.id);
      target = null;
      node?.focus();
      return Boolean(node);
    },
  };
}

// A dialog rendered without a Radix trigger would return focus to <body> on close, so it returns to
// the control that opened it. A menu item is gone once its menu closes; it stands for that menu's trigger.
export function dialogOpener(doc: OpenerDocument | undefined = globalThis.document): OpenerNode | null {
  const active = doc?.activeElement;
  if (!active || active === doc.body) return null;
  const menu = active.closest?.('[role="menu"]');
  if (!menu) return active;
  const triggers = [...doc.querySelectorAll('[aria-haspopup="menu"]')];
  return triggers.find(node => menu.id && node.getAttribute('aria-controls') === menu.id) || triggers.find(node => node.getAttribute('data-state') === 'open') || null;
}

// The first candidate still in the document that can take focus receives it.
export function restoreFocus(candidates: readonly (FocusTarget | null | undefined)[]) {
  const target = candidates.find((node): node is FocusTarget & Focusable => Boolean(node?.isConnected && typeof node.focus === 'function' && !node.disabled && !node.closest?.('[inert]')));
  target?.focus({ preventScroll: true });
  return target || null;
}

// Remember only explicit actions. Once their render settles, recover a removed or
// temporarily disabled control without taking focus from another surviving control.
export function useActionFocus(pending: boolean, fallback: () => readonly (FocusTarget | null | undefined)[]) {
  const origin = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (pending || !origin.current) return;
    const previous = origin.current;
    origin.current = null;
    if (document.activeElement === previous || document.activeElement === document.body) {
      restoreFocus([previous, ...fallback()]);
    }
  });
  return () => {
    const focused = document.activeElement;
    origin.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
  };
}

// The opener is read on the dialog's first render, before an autoFocus field moves focus inside it.
// `fallback` names a sensible element when the opener has gone, such as the case card or the sheet.
export function useReturnFocus(fallback?: () => FocusTarget | null | undefined) {
  const [opener] = useState(() => dialogOpener());
  const latest = useRef(fallback);
  latest.current = fallback;
  return useCallback((event: Event) => {
    event.preventDefault();
    restoreFocus([opener, latest.current?.()]);
  }, [opener]);
}
