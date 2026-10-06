// A twin's containers reach ports on the host's loopback through host.docker.internal, which Docker Desktop routes and a
// native Linux engine does not (docs/twins.md). There a Docker test skips what needs that route, with the note setup gives.
import { execFileSync } from 'node:child_process';
import { engineNote } from '../../scripts/setup.ts';

/** The skip of a test, or of its part, that needs that route: the opt-in's reason until it is set, setup's note on a native Linux engine, otherwise false. */
export function desktopSkip(optIn: string | false, platform: string = process.platform,
  system = () => execFileSync('docker', ['info', '--format', '{{.OperatingSystem}}'], { encoding: 'utf8', timeout: 30000 })): string | false {
  if (optIn) return optIn;
  if (platform !== 'linux') return false;
  let reported: string | null = null;
  // Without an engine the test runs, and Docker's own failure says why.
  try { reported = system(); } catch { reported = null; }
  return engineNote(platform, reported) ?? false;
}
