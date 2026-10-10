import { session } from './api.ts';
import { githubConnectionChanges } from './github-connection-changes.ts';
import type { GitHubConnection } from '../../../contract/github.ts';
import type { ConnectorsReply } from '../../../contract/connectors.ts';

// Short-lived display evidence only. Every mounted page still checks the controller;
// account actions and authorization failures discard the snapshot immediately.
function snapshot<T>() {
  let saved: { value: T; revision: string; expiresAt: number } | null = null;
  let generation = 0;
  return {
    read(revision = '') { return saved && saved.revision === revision && Date.now() < saved.expiresAt ? saved.value : null; },
    generation: () => generation,
    write(value: T, revision = '', expected = generation) { if (expected === generation && !session.signedOut()) saved = { value, revision, expiresAt: Date.now() + 15_000 }; },
    clear() { generation++; saved = null; },
  };
}

export const connectorSnapshot = snapshot<ConnectorsReply>();
export const githubSnapshot = snapshot<GitHubConnection>();
githubConnectionChanges.subscribe(() => githubSnapshot.clear());
session.subscribe(() => { if (session.signedOut()) { connectorSnapshot.clear(); githubSnapshot.clear(); } });
