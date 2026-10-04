/** URL.hostname after URL parsing: local browser targets, including the twin alias Chromium pins to loopback. */
export function localBrowserHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(host) || host === 'host.docker.internal';
}
