import { services as registry } from './registry.ts';
import type { Fidelity, Pattern, TwinService, TwinServices } from './registry.ts';

// The service catalog an agent authoring a twin config reads (./authoring.ts), generated from the registry: a new
// service file appears in it with nothing else to change. Each entry is what the service's own definition declares.

const FIDELITY: Record<Fidelity, string> = { actual: 'actual', 'official-sandbox': 'official sandbox', emulate: 'emulate' };
const code = (text: string) => `\`${text}\``;
const pattern = (value: Pattern) => value instanceof RegExp ? code(value.source) : code(value);
const list = (values: string[]) => values.join(', ');

function evidence({ detect }: TwinService) {
  const kinds = [['packages', detect?.packages], ['variables matching', detect?.env], ['files', detect?.files]] as const;
  return kinds.filter(([, values]) => values?.length).map(([label, values]) => `${label} ${list(values!.map(pattern))}`);
}

/** One service's catalog entry, in Markdown. */
export function catalogEntry(service: TwinService) {
  const { describe } = service, lines = [`### ${code(service.id)}: ${service.title} (${FIDELITY[service.fidelity]})`, ''];
  if (describe) lines.push(describe.summary, '');
  const options = Object.entries(describe?.options ?? {});
  if (describe) lines.push(options.length ? '- Options:' : '- Options: none.', ...options.map(([name, text]) => `  - ${code(name)}: ${text}`));
  if (describe?.provides.length) lines.push(`- Provides: ${list(describe.provides.map(code))}.`);
  if (describe?.ports?.length) lines.push(`- Addresses: ${list(describe.ports.map(port => code(`{{services.${service.id}.url.${port}}}`)))}.`);
  if (service.accounts) lines.push('- Creates test accounts from its options.');
  if (service.includes?.length) lines.push(`- Runs ${list(service.includes.map(code))} itself: never add ${service.includes.length > 1 ? 'them' : 'it'} beside this service.`);
  if (service.inputs?.length) lines.push(`- Inputs ${service.provision ? 'created on request or supplied once by the user' : 'the user supplies once'}; a required one that is missing blocks the service: ${list(service.inputs.map(input => `${code(input.name)} (${input.label ?? input.name}${input.optional ? ', optional' : ''})`))}.`);
  if (service.provision) lines.push('- Perpetual can create its inputs when the user asks.');
  const found = evidence(service);
  if (found.length) lines.push(`- A repository that needs it has ${found.join('; ')}.`);
  lines.push(...(describe?.notes ?? []).map(note => `- ${note}`));
  return lines.join('\n');
}

/** Every service of the registry, in Markdown. */
export const serviceCatalog = (services: TwinServices = registry) => Object.values(services).map(catalogEntry).join('\n\n');
