// Reading one file of a repository the controller does not own. The readers that refuse a link
// anywhere on the path, the scanner's configuration files and the service settings' evidence
// files, read through `readRepositoryFile`; a caller adds its own rule for which names it opens.
// The readers whose rules differ on purpose keep them: the twin snapshot and detection's readLocal
// (src/environments/plans.ts) follow a link that stays inside the root, and browser discovery's
// sampler (src/business/discovery.ts) checks each file's real path against the root.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

/** A path no reader opens for its contents, wherever it appears: env files, VCS and tool state, credential files, key material. */
export const SECRET_PATH = /(?:^|\/)(?:\.env[^/]*|\.git|\.ssh|\.aws|\.npmrc|\.netrc|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|keys?(?:\.[^/]*)?)(?:\/|$)|\.(?:pem|key|p12|pfx|jks)$/i;
const DEFAULT_LIMIT = 512 * 1024;

/** The path's segments, or null when it is absolute, empty, or climbs out of the root. */
function segments(relative: string) {
  const parts = relative.replaceAll('\\', '/').split('/');
  return path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || parts.some(part => !part || part === '.' || part === '..') ? null : parts;
}

/** The regular file at `root/relative` of at most `limit` bytes, once every component is checked without following links; null otherwise. */
async function locate(root: string, relative: string, limit: number) {
  const parts = segments(relative);
  if (!parts) return null;
  let location = root;
  for (const [index, part] of parts.entries()) {
    location = path.join(location, part);
    let stat;
    try { stat = await lstat(location); } catch { return null; }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) return null;
    if (index === parts.length - 1 && (!stat.isFile() || stat.size > limit)) return null;
  }
  return location;
}

/** Whether `root/relative` names a regular file of at most `limit` bytes that no link leads to. */
export const hasRepositoryFile = async (root: string, relative: string, { limit = DEFAULT_LIMIT } = {}) => (await locate(root, relative, limit)) !== null;

/**
 * The text of `root/relative`, or null when the path is absolute, climbs out of the root, is or
 * passes through a symbolic link, is not a regular file, or exceeds `limit` bytes. The file is
 * opened without following links and its size is checked again on the open handle, so neither a
 * link nor a growth between the checks is read. A leading byte order mark, which editors on Windows
 * often write and JSON.parse refuses, is not part of the text.
 */
export async function readRepositoryFile(root: string, relative: string, { limit = DEFAULT_LIMIT } = {}): Promise<string | null> {
  const location = await locate(root, relative, limit);
  if (!location) return null;
  let handle;
  try {
    handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return null;
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return size > limit ? null : buffer.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '');
  } catch { return null; }
  finally { await handle?.close(); }
}
