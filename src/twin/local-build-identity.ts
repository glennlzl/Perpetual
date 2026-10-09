import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { appCommand, PACKAGE_CACHE_ENV } from './compose.ts';
import type { TwinConfig } from './config.ts';

export type BuildSource = { revision: string; hash: string };
export type BuildImage = { id: string; os: string; architecture: string; variant?: string };

const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const HASH = /^[a-f0-9]{64}$/i;
const IMAGE = /^sha256:[a-f0-9]{64}$/i;
const LOCKFILES_BY_COMMAND: Record<string, readonly string[]> = {
  'npm ci': ['package-lock.json', 'npm-shrinkwrap.json'],
  'pnpm install --frozen-lockfile': ['pnpm-lock.yaml'],
  'bun install --frozen-lockfile': ['bun.lock', 'bun.lockb'],
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const validSource = (source: BuildSource) => REVISION.test(source.revision) && HASH.test(source.hash);
const validImage = (image: BuildImage) => IMAGE.test(image.id) && typeof image.os === 'string' && !!image.os
  && typeof image.architecture === 'string' && !!image.architecture
  && (image.variant === undefined || typeof image.variant === 'string');

/** True only for a pinned dependency graph represented by a regular lockfile inside the install directory. */
export async function hasInstallLockfile(sourceDirectory: string, config: Pick<TwinConfig, 'install'>): Promise<boolean> {
  if (!config.install || typeof sourceDirectory !== 'string' || !sourceDirectory) return false;
  const lockfiles = LOCKFILES_BY_COMMAND[config.install.command.trim()];
  if (!lockfiles) return false;
  const directory = join(sourceDirectory, config.install.directory);
  for (const name of lockfiles) {
    try {
      const info = await lstat(join(directory, name));
      if (info.isFile() && !info.isSymbolicLink()) return true;
    } catch { /* absent or inaccessible lockfiles make the build ineligible */ }
  }
  return false;
}

/** Derive reusable host-local build identities. Missing or unversioned inputs return no key. */
export async function localBuildKeys({ source, config, image, env, sourceDirectory, buildCommands }: {
  source: BuildSource;
  config: TwinConfig;
  image: BuildImage;
  env: Record<string, string>;
  sourceDirectory: string;
  buildCommands: (string | string[] | undefined)[];
}): Promise<{ install?: string; build?: string }> {
  if (!validSource(source) || !validImage(image) || !env || typeof env !== 'object' || Array.isArray(env)) return {};
  const platform = { id: image.id.toLowerCase(), os: image.os, architecture: image.architecture, ...(image.variant === undefined ? {} : { variant: image.variant }) };
  const installEligible = await hasInstallLockfile(sourceDirectory, config);
  const install = installEligible ? digest({
    schema: 1,
    source: { revision: source.revision.toLowerCase(), hash: source.hash.toLowerCase() },
    install: config.install,
    command: appCommand(config.install!.command),
    image: platform,
    packageCache: PACKAGE_CACHE_ENV,
  }) : undefined;

  // Service setup and fixtures mutate external or sandbox state, so its outputs cannot be safely reused.
  if (!install || Object.keys(config.services).length || config.fixtures.length) return install ? { install } : {};
  const build = digest({
    schema: 1,
    source: { revision: source.revision.toLowerCase(), hash: source.hash.toLowerCase() },
    install,
    image: platform,
    apps: Object.entries(config.apps).map(([id, app]) => [id, { ...app, env: Object.fromEntries(Object.entries(app.env).sort(([a], [b]) => a.localeCompare(b))) }]),
    env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))),
    buildCommands,
  });
  return { install, build };
}
