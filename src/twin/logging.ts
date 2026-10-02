/** Keep recent Docker diagnostics without letting a noisy twin fill the local engine's disk. */
export const containerLogging = () => ({
  driver: 'json-file',
  options: { 'max-size': '10m', 'max-file': '3' },
});
