/** A test account for one admitted execution. */
export type RunCredentials = { username: string; password: string };
/** The selected twin account's private sign-in data; its endpoints never belong to an entered account. */
export type AccountSignIn = RunCredentials & { authEndpoints?: readonly unknown[] };

type AccountRequest = { credentials?: unknown; accountId?: unknown };
type AccountTarget = { accounts?: readonly { id: string }[] | null };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// A username shorter than this is an ordinary word in most text, such as a tool name, an error or a page path: hiding
// it would garble that text without protecting the account.
const HIDDEN_USERNAME = 4;
/** The account values hidden from run and authoring text: the password always, the username from four characters. */
export function accountSecrets(account: { username?: unknown; password?: unknown } | null | undefined): string[] {
  const values: string[] = [];
  if (typeof account?.password === 'string' && account.password) values.push(account.password);
  if (typeof account?.username === 'string' && account.username.length >= HIDDEN_USERNAME) values.push(account.username);
  return values;
}

// Credentials belong to one admitted execution, never a saved case or config.
export function validateRunCredentials(value: unknown): RunCredentials | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)
    || Object.keys(value).some(key => !['username', 'password'].includes(key))
    || typeof value.username !== 'string' || !value.username.trim() || value.username.length > 320
    || typeof value.password !== 'string' || !value.password || value.password.length > 1024
    || /[\x00-\x1f\x7f]/.test(value.username + value.password)) {
    throw new Error('Provide a test account with a username and password.');
  }
  return { username: value.username, password: value.password };
}

/**
 * Validate and snapshot a request's account choice before admission awaits. The returned resolver reads private twin
 * data only after the caller holds its target and finishes runtime preflight. Omission chooses the twin's first account;
 * null chooses none. Only a selected twin account contributes its own sign-in endpoints.
 */
export function selectRunAccount({ credentials: value, accountId }: AccountRequest) {
  const credentials = validateRunCredentials(value);
  if (accountId !== undefined && (credentials || accountId !== null && typeof accountId !== 'string')) throw new Error('Choose one test account.');
  return async <Target extends AccountTarget>(target: Target | null | undefined, read: (target: Target, id: string) => Promise<AccountSignIn | null | undefined>): Promise<{ credentials: RunCredentials | undefined; authEndpoints: readonly unknown[] }> => {
    const accounts = target?.accounts ?? [];
    if (typeof accountId === 'string' && !accounts.some(account => account.id === accountId)) throw new Error('Choose a test account of this environment.');
    if (credentials || accountId === null || !target || !accounts.length) return { credentials, authEndpoints: [] };
    const account = await read(target, accountId ?? accounts[0].id);
    const selected = account ? validateRunCredentials({ username: account.username, password: account.password }) : undefined;
    if (!selected) throw new Error('The environment test account is unavailable. Recreate the environment.');
    return { credentials: selected, authEndpoints: account?.authEndpoints ?? [] };
  };
}
