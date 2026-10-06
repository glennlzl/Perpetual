type Change = 'connect' | 'disconnect';
const listeners = new Set<(change: Change) => void>();
/** A completed explicit account action; a read error never announces a disconnect. */
export const githubConnectionChanges = {
  subscribe(listener: (change: Change) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  notify(change: Change) { listeners.forEach(listener => listener(change)); },
};
