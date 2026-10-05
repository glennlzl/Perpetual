// Failure diagnostics only. These observations never supply a reviewed check or change an action.
import type { BrowserContext, Page } from '@playwright/test';
import { setTimeout, clearTimeout } from 'node:timers';
import { failureText, hide } from '../../redaction.ts';

const KEY = 'perpetual.action-observation';

function observeEdits(key: string) {
  type Field = HTMLInputElement | HTMLTextAreaElement;
  const fields = (node: Element): node is Field => node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement && ['text', 'email', 'search', 'url', 'tel', 'number'].includes(node.type);
  // Do not read field values, including textarea text inside a wrapping label.
  const words = (node: Element) => {
    if (node.matches('input,textarea,select') || node.closest('[contenteditable]')) return '';
    let at: Node | null = node.firstChild, seen = 0, text = '';
    while (at && seen++ < 100 && text.length <= 1024) {
      if (at.nodeType === Node.TEXT_NODE) text += at.textContent || '';
      if (at instanceof Element && !at.matches('input,textarea,select,[contenteditable]') && at.firstChild) { at = at.firstChild; continue; }
      while (at && !at.nextSibling && at.parentNode !== node) at = at.parentNode;
      at = at?.nextSibling || null;
    }
    return at || text.length > 1024 ? '[Label too long]' : text.trim();
  };
  const name = (node: Field) => {
    const direct = node.getAttribute('aria-label'), ids = node.getAttribute('aria-labelledby') || '';
    if (direct) return direct.length <= 1024 ? direct : '[Label too long]';
    if (ids.length > 1024) return '[Label too long]';
    const associated: string[] = [];
    for (const label of node.labels || []) { if (associated.length === 12) break; associated.push(words(label)); }
    const label = ids.split(/\s+/).slice(0, 12).map(id => document.getElementById(id)).filter((item): item is HTMLElement => Boolean(item)).map(words).join(' ') || associated.join(' ') || 'Unlabelled field';
    return label.length <= 1024 ? label : '[Label too long]';
  };
  const edited: { node: Field; name: string }[] = [];
  const shown = (node: Element) => node.getClientRects().length > 0 && node.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  Object.defineProperty(window, Symbol.for(key), { value: {
    reset: () => { edited.length = 0; },
    read: () => {
      const visibleFields: { name: string; empty: boolean; invalid: boolean }[] = [], buttons: string[] = [];
      const walkers = [document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT)], deadline = performance.now() + 25;
      for (let visited = 0; visited < 1000 && walkers.length && performance.now() < deadline; visited++) {
        const node = walkers.at(-1)!.nextNode() as Element | null;
        if (!node) { walkers.pop(); continue; }
        if (node.shadowRoot) walkers.push(document.createTreeWalker(node.shadowRoot, NodeFilter.SHOW_ELEMENT));
        if (visibleFields.length < 12 && fields(node) && shown(node)) visibleFields.push({ name: name(node), empty: node.value.length === 0, invalid: !node.validity.valid });
        if (buttons.length < 12 && (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') && shown(node)) {
          const text = node.getAttribute('aria-label') || words(node);
          buttons.push(text.length <= 1024 ? text : '[Label too long]');
        }
        if (visibleFields.length === 12 && buttons.length === 12) break;
      }
      return {
        removed: edited.filter(item => !item.node.isConnected).map(item => item.name).slice(-12),
        fields: visibleFields, buttons,
      };
    },
  } });
  window.addEventListener('input', event => {
    const node = event.composedPath()[0];
    if (!(node instanceof Element) || !fields(node) || edited.some(item => item.node === node)) return;
    edited.push({ node, name: name(node) });
    if (edited.length > 20) edited.shift();
  }, true);
}

export const installActionObservation = (context: BrowserContext) => context.addInitScript(observeEdits, KEY);

// A hung page cannot extend an action's failure while gathering optional diagnostics.
async function bounded<T>(work: Promise<T>): Promise<T | undefined> {
  let cancel = () => {};
  try { return await Promise.race([work.catch(() => undefined), new Promise<undefined>(resolve => { const timer = setTimeout(resolve, 500); cancel = () => clearTimeout(timer); })]); }
  finally { cancel(); }
}

export async function resetActionObservation(page: Page) {
  await bounded(page.evaluate(key => { (window as unknown as Record<symbol, { reset(): void }>)[Symbol.for(key)]?.reset(); }, KEY));
}

/** Current visible form state and removed edited controls, never values, page prose, URLs or request payloads. */
export async function actionFeedback(page: Page, secrets: readonly (string | undefined)[]): Promise<string | undefined> {
  const value: unknown = await bounded(page.evaluate(key => (window as unknown as Record<symbol, { read(): unknown }>)[Symbol.for(key)]?.read(), KEY));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const data = value as Record<string, unknown>, clean = (text: string) => failureText(hide(secrets)(text), 100);
  const names = (input: unknown) => Array.isArray(input) ? input.slice(0, 12).filter((item): item is string => typeof item === 'string' && item.length <= 1024).map(clean).filter(Boolean) : [];
  const fields = Array.isArray(data.fields) ? data.fields.slice(0, 12).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const field = item as Record<string, unknown>;
    return typeof field.name === 'string' && field.name.length <= 1024 && typeof field.empty === 'boolean' && typeof field.invalid === 'boolean'
      ? [`Current field ${clean(field.name)}: ${field.empty ? 'empty' : 'nonempty'}${field.invalid ? ', invalid' : ''}.`] : [];
  }) : [];
  const removed = names(data.removed), buttons = names(data.buttons);
  const lines = [...removed.map(name => `Edited control removed: ${name}.`), ...fields, ...(buttons.length ? [`Visible buttons: ${buttons.join('; ')}.`] : [])];
  return lines.length ? failureText(lines.join('\n'), 2000) : undefined;
}
