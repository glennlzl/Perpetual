// Every supported service: one import per file in ./services/.
import type { Json, JsonObject } from './config.ts';
import emulate from './services/emulate.ts';
import llm from './services/llm.ts';
import mailpit from './services/mailpit.ts';
import mongodb from './services/mongodb.ts';
import postgres from './services/postgres.ts';
import redis from './services/redis.ts';
import secrets from './services/secrets.ts';
import stripe from './services/stripe.ts';
import supabase from './services/supabase.ts';
import triggerDev from './services/trigger-dev.ts';

/** Where a service's stand-in comes from, recorded with run results. */
export type Fidelity = 'actual' | 'official-sandbox' | 'emulate';
/** A detection pattern: an exact name (or, for files, a path suffix) or an expression. */
export type Pattern = string | RegExp;
export type CommandOutput = { stdout: string; stderr?: string };
/** docker(args, { timeoutMs }) -> { stdout, stderr }, for a provision. */
export type DockerCommand = (args: string[], options?: { timeoutMs?: number }) => Promise<CommandOutput>;
/** Variables as a service returns them: empty values are dropped, the rest become text. */
export type EnvInput = Record<string, string | number | boolean | null | undefined>;
/** Input values of one service by input name. */
export type InputValues = Record<string, string>;
export type ServiceOutputs = Record<string, unknown>;

/** A value the user supplies, e.g. a test key; `pattern` checks its format. */
export interface ServiceInput { name: string; label?: string; pattern?: Pattern; secret?: boolean; optional?: boolean; help?: string }
export interface ProvisionInput { name: string; label?: string; default?: string }
/** What a provision returns; the store checks it like a manual save. */
export interface ProvisionResult { values?: Record<string, string | undefined>; details?: { expiresAt?: string; claimUrl?: string; account?: string } }
export interface ServiceProvision {
  inputs: ProvisionInput[];
  run(options: { inputs: InputValues; docker: DockerCommand; tempDir: string }): Promise<ProvisionResult | undefined>;
}
export interface ContainerHealth { http?: { port: number | string; path?: string }; command?: string | string[] }
/** A health-checked container an official CLI owns outside the twin's Compose project. */
export interface ServiceHealthContainer { name: string; labels: Record<string, string> }
/** One container of a service; `directory` runs it in that snapshot directory, like an app. */
export interface ServiceContainer {
  name: string; image: string; command?: string | string[]; env?: EnvInput; ports?: Record<string, number>; health?: ContainerHealth; directory?: string;
}

/**
 * A service's options as a twin config gives them: the config checks only that they form an object of JSON values, so
 * each field is any JSON value, which the service narrows where it uses it (./options.ts). A narrower field type would
 * claim a check nothing made, and does not satisfy this.
 */
export type ServiceOptions<Options> = { [K in keyof Options]: Json extends Exclude<Options[K], undefined> ? Options[K] : never };
/** What each service function receives from the twin runtime. */
export interface ServiceContext<Options extends ServiceOptions<Options> = JsonObject, Outputs = ServiceOutputs> {
  options: Options; inputs: InputValues; outputs: Outputs;
  host: string; project: string; dir: string; shared: string; source: string;
  port(name: string): number;
  url(name: string, path?: string): string;
  sharedPort(name: string, current?: unknown): Promise<number>;
  app(id: string): { url: string; port: number };
  /** service-only mounts just this service's private directory read-only, without the source snapshot. */
  run(image: string, args: string[], options?: { env?: EnvInput; mounts?: 'service-only' }): Promise<CommandOutput>;
  exec(file: string, args: string[], options?: { cwd?: string }): Promise<CommandOutput>;
  /** Tests supply their own; services otherwise use the global fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * What the service catalog an authoring agent reads says about a service (./catalog.ts), and what the evidence's
 * unwired variables leave out (../environments/evidence.ts); nothing reads it at run time.
 */
export interface ServiceDescription {
  /** What the service is, in a sentence. */
  summary: string;
  /** Each option of its twin config section, and what it takes; the catalog's checks refuse any other. */
  options: Record<string, string>;
  /** The standard variables it provides whatever its options: an app variable of the same name gets the value without a mapping. */
  provides: string[];
  /** Variables this service owns even when an option or missing input keeps it from supplying them. */
  owns?: readonly string[];
  /**
   * The standard variables its options add, such as names an option lists or one only an option turns on. Options are
   * unchecked, so it never throws.
   */
  optionProvides?(options: JsonObject): string[];
  /**
   * Whether setup may still provide a variable its options do not add, as a repository file its options name may: known
   * only then, and checked then. One an option decides is never left to setup. Options are unchecked, so it never throws.
   */
  setupProvides?(options: JsonObject, variable: string): boolean;
  /** Its named ports, each an address {{services.<id>.url.<port>}}. */
  ports?: string[];
  /** Anything else an author needs, such as variables an option names. */
  notes?: string[];
}

/** A service definition. Its functions are methods, so a service with its own Options and Outputs is still a TwinService. */
export interface TwinService<Options extends ServiceOptions<Options> = JsonObject, Outputs = ServiceOutputs> {
  id: string; title: string; fidelity: Fidelity;
  /** How a repository shows it uses the service; options(evidence) gives the options its proposal starts with. */
  detect?: { files?: Pattern[]; packages?: Pattern[]; env?: Pattern[]; options?(evidence: { packages: readonly string[]; env: readonly string[] }): JsonObject };
  /** Services this one supplies itself, e.g. a local stack with its own database. */
  includes?: string[];
  inputs?: ServiceInput[];
  provision?: ServiceProvision;
  checklist?: { id: string; title: string; url: string }[];
  describe?: ServiceDescription;
  /** Checks its options as its setup reads them, so a config is refused before anything runs; throws the first problem. */
  validate?(options: Options): void;
  setup?(ctx: ServiceContext<Options, Outputs>): Promise<Outputs>;
  containers?(ctx: ServiceContext<Options, Outputs>): ServiceContainer[];
  /** Read-only declaration of exact owned containers; it receives no setup, account or command capabilities. */
  healthContainers?(ctx: Pick<ServiceContext, 'project' | 'dir'>): Promise<ServiceHealthContainer[]>;
  env(ctx: ServiceContext<Options, Outputs>): EnvInput;
  /** Test accounts, checked by the runtime before they are stored. */
  accounts?(ctx: ServiceContext<Options, Outputs>): Promise<unknown>;
  teardown?(ctx: ServiceContext<Options, Outputs>): Promise<void>;
}
export type TwinServices = Readonly<Record<string, TwinService>>;

const list: TwinService[] = [postgres, redis, mongodb, mailpit, llm, secrets, supabase, stripe, triggerDev, emulate];

export const services: TwinServices = Object.freeze(Object.fromEntries(list.map(service => [service.id, service])));
if (Object.keys(services).length !== list.length) throw new Error('Twin service ids must be unique.');
