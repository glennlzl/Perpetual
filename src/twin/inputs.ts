import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gitReadOnly } from '../process.ts';
import { createSaveQueue, privateDirectory, readStateFile, writeStateFile } from '../store.ts';
import { fail, plain } from './config.ts';
import { services as registry } from './registry.ts';
import type { DockerCommand, InputValues, ProvisionResult, ServiceInput, TwinService, TwinServices } from './registry.ts';

// User-supplied test credentials, stored once per machine and reused across twins.
// Views say only which inputs are set; values go to the twin runtime and nowhere else.
// A service that declares `provision: { inputs, run }` can instead create its values on the user's action, e.g. a
// sandbox that expires. Its record (the inputs it ran with, expiry, claim link) is kept apart from the values, is
// renewed before it expires, and once expired its values are never used.

const FILE = 'twin-inputs.json';
const PROVISIONS = 'twin-provisions.json';
// Credentials and provision metadata are small; each file is limited to 1 MiB on both read and write.
const STORAGE_LIMIT = 1024 * 1024;
/** A provision input default the controller fills from `git config --global user.email`. */
const GIT_EMAIL = 'git-email';
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A provision's record, kept apart from the values it provided. */
export interface ProvisionRecord { inputs: InputValues; expiresAt: string; claimUrl?: string; account?: string; provisionedAt: string }
type WithInputs = TwinService & { inputs: ServiceInput[] };
const hasInputs = (item: TwinService): item is WithInputs => Boolean(item.inputs?.length);

const execFileAsync = promisify(execFile);
/** docker(args, { timeoutMs }) -> { stdout, stderr }. A failure carries none of the command's output, which may hold keys. */
export async function dockerCommand(args: string[], { timeoutMs }: { timeoutMs?: number } = {}) {
  try { return await execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) { throw new Error((error as ExecFileException).killed ? 'The docker command timed out.' : 'The docker command failed.'); }
}
/** The global git email, or '' when it is unset. */
export const globalGitEmail = () => gitReadOnly(process.cwd(), ['config', '--global', '--get', 'user.email'], { timeout: 2000, maxBuffer: 64 * 1024 }).then(({ stdout }) => stdout.trim(), () => '');

// Shared by every store instance in this process: one provisioning per service, and one write at a time.
const provisioning = new Map<string, Promise<void>>();
const saves = createSaveQueue();
const busy = (item: TwinService) => Object.assign(new Error(`${item.title} setup is already running.`), { statusCode: 409 });

const valid = (input: ServiceInput, value: unknown): value is string => typeof value === 'string' && value.length > 0 && (!input.pattern || new RegExp(input.pattern).test(value));

/** Names of the required inputs a service declares that have no valid value. */
export const missingInputs = (service: Pick<TwinService, 'inputs'>, values: Readonly<Record<string, unknown>> = {}) => (service.inputs ?? []).filter(input => !input.optional && !valid(input, values[input.name])).map(input => input.name);

export function createTwinInputs({ dataDir, services = registry, docker = dockerCommand, gitEmail = globalGitEmail, now = () => new Date() }: {
  dataDir: string; services?: TwinServices; docker?: DockerCommand; gitEmail?: () => Promise<string>; now?: () => Date;
}) {
  const file = join(dataDir, FILE), records = join(dataDir, PROVISIONS);
  const directory = () => privateDirectory(dataDir, 'Twin input storage must not be a symbolic link.');
  // Both files are this store's own, by service id: values by input name, and provision records. Each entry is checked
  // where it is read.
  const read = async (path: string): Promise<Record<string, unknown>> => {
    await directory();
    const stored = await readStateFile(path, { limit: STORAGE_LIMIT, invalid: 'Invalid twin input storage.' });
    return plain(stored) ? stored : {};
  };
  const write = async (...entries: [string, Record<string, unknown>][]) => {
    // Refuse oversized provision metadata before replacing the credentials that belong to it.
    const contents = entries.map(([path, value]) => {
      const content = `${JSON.stringify(value, null, 2)}\n`;
      if (Buffer.byteLength(content) > STORAGE_LIMIT) fail('Twin input storage is full.');
      return { path, content };
    });
    await directory();
    for (const { path, content } of contents) await writeStateFile(path, content, { prefix: '.twin-inputs-', removeTemporary: true });
  };
  const service = (id: string) => Object.hasOwn(services, id) ? services[id] : fail(`Unknown service "${id}".`);
  // UTC dates: a record whose expiry is today or earlier has expired.
  const date = (days = 0) => new Date(now().getTime() + days * DAY).toISOString().slice(0, 10);
  const expiresBy = (record: unknown, day: string) => plain(record) && !(typeof record.expiresAt === 'string' && record.expiresAt > day);
  const lapsed = (record: unknown) => expiresBy(record, date());
  const valuesOf = (entry: unknown) => plain(entry) ? entry : undefined;
  const isProvision = (record: unknown): record is ProvisionRecord => plain(record) && typeof record.expiresAt === 'string' && typeof record.provisionedAt === 'string'
    && plain(record.inputs) && Object.values(record.inputs).every(value => typeof value === 'string') && (record.claimUrl === undefined || typeof record.claimUrl === 'string');
  /** Stored values without those of an expired provision, with the provision records. */
  async function current() {
    const [stored, provisions] = await Promise.all([read(file), read(records)]);
    return { provisions, stored: Object.fromEntries(Object.entries(stored).filter(([id]) => !lapsed(provisions[id]))) };
  }
  const key = (id: string) => `${resolve(file)}\0${id}`;
  // Starts work as the service's one provisioning; null while another runs.
  function exclusive(id: string, work: () => Promise<void>) {
    if (provisioning.has(key(id))) return null;
    const run = work().finally(() => provisioning.delete(key(id)));
    provisioning.set(key(id), run);
    return run;
  }

  async function view() {
    const { stored, provisions } = await current();
    const listed = Object.values(services).filter(hasInputs);
    const email = listed.some(item => item.provision?.inputs.some(input => input.default === GIT_EMAIL)) ? await gitEmail() : '';
    return listed.map(item => {
      const record = provisions[item.id];
      return { id: item.id, title: item.title,
        inputs: item.inputs.map(input => ({ name: input.name, label: input.label, secret: Boolean(input.secret), ...(input.help ? { help: input.help } : {}),
          set: valid(input, valuesOf(stored[item.id])?.[input.name]) })),
        ...(item.provision ? { provision: { inputs: item.provision.inputs.map(input => ({ name: input.name, label: input.label ?? input.name,
          value: input.default === GIT_EMAIL ? email : typeof input.default === 'string' ? input.default : '' })) } } : {}),
        // The claim link is for this local view only; keys never appear in any view.
        ...(isProvision(record) && !lapsed(record) ? { provisioned: { expiresAt: record.expiresAt, ...(record.claimUrl ? { claimUrl: record.claimUrl } : {}) } } : {}) };
    });
  }

  /** Valid values by service id, for the twin runtime only. An expired provision's values are left out, so its service is blocked. */
  async function values() {
    const { stored } = await current();
    return Object.fromEntries(Object.values(services).filter(hasInputs).map(item => [item.id,
      Object.fromEntries(item.inputs.flatMap((input): [string, string][] => { const value = valuesOf(stored[item.id])?.[input.name]; return valid(input, value) ? [[input.name, value]] : []; }))]));
  }

  /** Sets or, with null or '', clears inputs of one service. The user's own values end its provision, e.g. once claimed,
   * and replace all the values it provided, so none pairs with keys of another account or outlives its record. */
  async function set(id: string, entries: unknown) {
    const item = service(id), { inputs = [] } = item;
    if (!plain(entries)) fail('Inputs must map input names to values.');
    if (provisioning.has(key(id))) throw busy(item);
    await saves.run(async () => {
      const { stored, provisions } = await current();
      const next: Record<string, unknown> = Object.hasOwn(provisions, id) ? {} : { ...valuesOf(stored[id]) };
      for (const [name, value] of Object.entries(entries)) {
        const input = inputs.find(entry => entry.name === name) ?? fail(`${id} has no input named ${name}.`);
        if (value == null || value === '') { delete next[name]; continue; }
        if (!valid(input, value)) fail(`${input.label ?? name} does not have the expected format.`);
        next[name] = value;
      }
      const inputFile: [string, Record<string, unknown>] = [file, { ...await read(file), [id]: next }];
      if (Object.hasOwn(provisions, id)) { const { [id]: ended, ...rest } = provisions; await write(inputFile, [records, rest]); }
      else await write(inputFile);
    });
    return view();
  }

  // Runs the service's provision in a private empty directory, which may receive keys and is always removed, then
  // stores its values, checked like a manual save, in place of the service's values, and its record. A renewal
  // passes the record it renews and stores nothing once a save has ended it or another provision replaced it.
  // Only services with a provision reach here, and its values are ones the service declares as inputs.
  async function run(item: TwinService, inputs: InputValues, renewing?: Pick<ProvisionRecord, 'provisionedAt'>) {
    await directory();
    const tempDir = await mkdtemp(join(dataDir, 'provision-'));
    let result: ProvisionResult | undefined;
    try { await chmod(tempDir, 0o700); result = await item.provision!.run({ inputs: { ...inputs }, docker, tempDir }); }
    finally { await rm(tempDir, { recursive: true, force: true }); }
    const { values: provided, details } = result ?? {};
    if (!plain(provided)) fail(`${item.title} provided no inputs.`);
    for (const [name, value] of Object.entries(provided)) {
      const input = item.inputs!.find(entry => entry.name === name) ?? fail(`${item.id} has no input named ${name}.`);
      if (!valid(input, value)) fail(`${input.label ?? name} does not have the expected format.`);
    }
    if (missingInputs(item, provided).length) fail(`${item.title} provided no ${missingInputs(item, provided).join(', ')}.`);
    if (!details || !DATE.test(details.expiresAt ?? '')) fail(`${item.title} provided no expiry date.`);
    const claimUrl = typeof details.claimUrl === 'string' && details.claimUrl.startsWith('https://') ? details.claimUrl : null;
    const account = typeof details.account === 'string' && details.account ? details.account : null;
    await saves.run(async () => {
      const provisions = await read(records), record = provisions[item.id];
      if (renewing && !(plain(record) && record.provisionedAt === renewing.provisionedAt)) return;
      await write([file, { ...await read(file), [item.id]: { ...provided } }],
        [records, { ...provisions, [item.id]: { inputs: { ...inputs }, expiresAt: details.expiresAt,
          ...(claimUrl ? { claimUrl } : {}), ...(account ? { account } : {}), provisionedAt: now().toISOString() } }]);
    });
  }

  /** Provisions one service on the user's action; its inputs are the ones it declares. One at a time per service (409). */
  async function provision(id: string, entries: unknown) {
    const item = service(id);
    if (!item.provision) fail(`${item.title} cannot be set up automatically.`);
    if (!plain(entries)) fail('Inputs must map input names to values.');
    for (const name of Object.keys(entries)) if (!item.provision.inputs.some(input => input.name === name)) fail(`${id} has no input named ${name}.`);
    const inputs = Object.fromEntries(item.provision.inputs.map(input => [input.name, typeof entries[input.name] === 'string' ? entries[input.name] as string : '']));
    await (exclusive(id, () => run(item, inputs)) ?? Promise.reject(busy(item)));
    return view();
  }

  /** Renews, from its stored inputs, each provision that expires by tomorrow (UTC), of `ids` or every service.
   * Returns [{ id }] or [{ id, error }] per renewal; a failure is never thrown, and its service expires and is blocked.
   * A save that ends the record while it renews wins: the renewal then stores nothing. */
  async function refresh(ids = Object.keys(services)) {
    const provisions = await read(records), tomorrow = date(1);
    const due = [...new Set(ids)].filter(id => Object.hasOwn(services, id) && services[id].provision && expiresBy(provisions[id], tomorrow));
    // Decided again under the service's lock, from its record then: a save or another provision may have replaced it.
    const renew = async (id: string) => { const record = (await read(records))[id];
      if (isProvision(record) && expiresBy(record, tomorrow)) await run(services[id], record.inputs, record); };
    return Promise.all(due.map(async id => {
      // A provisioning already running for this service, e.g. the user's, is the renewal.
      try { await (exclusive(id, () => renew(id)) ?? provisioning.get(key(id))); return { id }; }
      catch (error) { return { id, error: (error as Error).message }; }
    }));
  }

  return { view, values, set, provision, refresh };
}
export type TwinInputs = ReturnType<typeof createTwinInputs>;
