import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

type BrowserStart = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Hands the controller's launch link to the default browser. A missing desktop never stops the controller. */
export function openBrowser(url: string, onFailure: () => void, { platform = process.platform, start = spawn }: { platform?: NodeJS.Platform; start?: BrowserStart } = {}): void {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  let reported = false;
  const failed = () => { if (!reported) { reported = true; onFailure(); } };
  try {
    // Desktop launchers may stay alive with the browser. Neither their lifetime nor their output belongs to the server.
    const child = start(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', failed);
    child.once('exit', code => { if (code !== 0) failed(); });
    child.unref();
  } catch { failed(); } // An OS error can repeat the credential in the command; only the fixed fallback leaves here.
}
