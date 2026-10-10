import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStateFile, writeStateFile } from '../../src/store.ts';
import type { TrialDisconnectReply, TrialLinkReply, TrialProfileReply, TrialStatusReply } from '../../contract/broker-trial.ts';

const MAX_RESPONSE_BYTES = 32 * 1024;

async function responseText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error('Invalid broker response.');
  }
  if (!response.body) throw new Error('Invalid broker response.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Invalid broker response.');
      }
      chunks.push(value);
    }
  } catch {
    throw new Error('Invalid broker response.');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Invalid broker response.'); }
}

export async function trialRequest(file: string, action: 'connect' | 'status' | 'profile' | 'disconnect'): Promise<TrialLinkReply | TrialDisconnectReply | TrialStatusReply | TrialProfileReply> {
  const raw = await readStateFile(file, { limit: 2048, invalid: 'Invalid client pairing.' });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid client pairing.');
  const config = raw as Record<string, unknown>;
  if (typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.token) || typeof config.brokerUrl !== 'string') throw new Error('Invalid client pairing.');
  const origin = new URL(config.brokerUrl);
  if (origin.href !== 'http://127.0.0.1:43179/') throw new Error('This experiment only supports the local trial broker.');
  const response = await fetch(new URL(`/trial/${action}`, origin), {
    method: action === 'status' ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    ...(action === 'status' ? {} : { body: '{}' }),
    redirect: 'error', signal: AbortSignal.timeout(35000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Trial request failed (${response.status}).`); }
  const text = await responseText(response);
  const result: unknown = JSON.parse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid broker response.');
  const data = result as Record<string, unknown>;
  if (action === 'connect' && typeof data.redirectUrl === 'string') {
    const url = new URL(data.redirectUrl);
    if (url.protocol !== 'https:' || !['connect.composio.dev', 'backend.composio.dev'].includes(url.hostname) || url.username || url.password) throw new Error('Invalid broker handoff.');
    return { redirectUrl: url.href };
  }
  if (action === 'status' && typeof data.status === 'string' && ['not-connected', 'pending', 'connected', 'unverified', 'needs-auth'].includes(data.status)) return { status: data.status as TrialStatusReply['status'] };
  if (action === 'disconnect' && data.status === 'not-connected') return { status: 'not-connected' };
  if (action === 'profile' && [data.id, data.name, data.email].every(value => typeof value === 'string' && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value))) return { id: data.id as string, name: data.name as string, email: data.email as string };
  throw new Error('Invalid broker response.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action, file, output] = process.argv.slice(2);
    if (!file || !['connect', 'status', 'profile', 'disconnect'].includes(action ?? '') || (action === 'connect' && !output)) throw new Error('Use connect|status|profile|disconnect with a private pairing file; connect also requires a private output path.');
    const result = await trialRequest(file, action as 'connect' | 'status' | 'profile' | 'disconnect');
    if (action === 'connect') { await writeStateFile(output!, JSON.stringify(result)); console.log('Private authorization link saved.'); }
    else if (action === 'disconnect') console.log('Connection removed.');
    else if ('status' in result) console.log(JSON.stringify(result));
    else console.log('Current account profile verified.');
  } catch { console.error('Trial request did not complete. Check pairing, broker setup and connection status.'); process.exitCode = 1; }
}
