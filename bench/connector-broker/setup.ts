import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateDirectory, privateFileExists, writeStateFile } from '../../src/store.ts';

/** Operator pairing for the localhost experiment, not a public sign-up or user identity system. */
export async function provisionTrial(root: string) {
  const directory = await privateDirectory(root, 'Invalid trial directory.');
  const serverDirectory = await privateDirectory(join(directory, 'server'), 'Invalid trial server directory.');
  const clientsDirectory = await privateDirectory(join(directory, 'clients'), 'Invalid trial client directory.');
  const principalsFile = join(serverDirectory, 'principals.json');
  if (await privateFileExists(principalsFile, 'Invalid trial principals file.')) throw new Error('Trial already provisioned. Use the existing pairing or a new private directory.');
  const principals = [];
  for (const name of ['a', 'b']) {
    const file = join(clientsDirectory, `${name}.json`);
    if (await privateFileExists(file, 'Invalid trial client file.')) throw new Error('Trial client already exists.');
  }
  for (const name of ['a', 'b']) {
    const token = randomBytes(32).toString('base64url');
    principals.push({ id: `broker-trial-${randomUUID()}`, tokenHash: createHash('sha256').update(token).digest('hex') });
    await writeStateFile(join(clientsDirectory, `${name}.json`), JSON.stringify({ brokerUrl: 'http://127.0.0.1:43179', token }));
  }
  await writeStateFile(principalsFile, JSON.stringify(principals));
  return { principalsFile, clientsDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = process.argv[2];
    if (!root) throw new Error('Supply a new private trial directory.');
    const paths = await provisionTrial(root);
    console.log(`Pairing ready. Server: ${paths.principalsFile}. Clients: ${paths.clientsDirectory}. No Composio key was created or copied.`);
  } catch { console.error('Could not provision the trial. Check the directory; existing pairings are never overwritten.'); process.exitCode = 1; }
}
