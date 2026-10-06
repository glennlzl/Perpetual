/** The repository named by an HTTPS or SSH GitHub remote; no connection or access is implied. */
export function parseGitHubRemote(remote: unknown = ''): string | null {
  const match = String(remote).match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return match?.[1] || null;
}

/** A browser link to the actual repository remote, independent of credentials and source configuration. */
export function githubRepositoryUrl(remote: unknown): string | null {
  const repository = parseGitHubRemote(remote);
  return repository ? `https://github.com/${repository.split('/').map(encodeURIComponent).join('/')}` : null;
}
