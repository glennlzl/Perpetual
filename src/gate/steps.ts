// A gate's work on the controller: rebuild the stage's twin through the environments manager,
// then run its reviewed, selected journeys through the browser manager.
import { IN_PROGRESS, holdsResources, isEnvironmentBusy, isStageHeld } from '../environments/usage.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { EnvironmentSummary } from '../environments/manager.ts';
import type { GateSteps } from './manager.ts';
import type { GateRef, RunRollup } from './rules.ts';

/** The stage a gate works on; the context its checkout returns carries at least this. */
export interface StageContext { key: string; stageId: string }
/** An environment as the environments manager summarises it, as far as the gate reads it. */
export type GateEnvironment = Pick<EnvironmentSummary, 'id' | 'stageId' | 'status' | 'sandboxId' | 'cleanedAt' | 'readsCheckout'>;
/** An environment once it is idle: ready, destroyed, or failed with its error. */
export type IdleEnvironment = Pick<EnvironmentSummary, 'id' | 'status' | 'error'>;
/** What the gate uses of the environments manager. */
export interface GateEnvironments<C> {
  summaries(key: string): readonly GateEnvironment[];
  /** Whether a create for the pipeline was admitted and has yet to record its environment, which then copies the source. */
  admitting(key: string): boolean;
  destroy(context: C, id: string): Promise<unknown>;
  awaitIdle(id: string): Promise<IdleEnvironment>;
  create(context: C): Promise<{ environment: { id: string } }>;
  resolveTarget(url: string): { id: string } | null | undefined;
}
/** A case's review state, as the browser manager's summary lists it. */
export interface JourneySelection { selected?: boolean; needsReview?: boolean }
export type GateRun = RunRollup & { id: string; status: string };
/** What the gate uses of the browser manager. */
export interface GateBrowser<C> {
  isActive(stage: StageContext): boolean;
  summary(context: C): { cases?: readonly JourneySelection[] | null };
  view(context: C): Promise<{ config: { targetUrl?: string | null } }>;
  /** The run names the environment its application URL resolved to when it was admitted. */
  run(context: C, input: Record<string, never>): Promise<{ run: { id: string; environmentId?: string } }>;
  runProgress(context: C, id: string): Promise<{ run: GateRun }>;
}
export interface Readiness { done(id: string): void; wait(id: string): Promise<void>; forget(id: string): void }
export interface GateStepsOptions<C extends StageContext> {
  environments: GateEnvironments<C>; browser: GateBrowser<C>; readiness: Readiness;
  checkout(gate: GateRef): Promise<C>; signal?: AbortSignal; interval?: number;
  /** Before a twin is built from the checkout: throws when it is not exactly the gate's commit, so the gate needs release. */
  checkoutAt?(context: C): Promise<void>;
}

const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
// A twin that has yet to copy the source, or whose preparation still reads the checkout, as generating a twin config
// does; a gate may move the source in place only once none is left.
const COPYING = ['queued', 'creating'];
const readsSource = (item: GateEnvironment) => COPYING.includes(item.status) || item.status === 'preparing' && item.readsCheckout === true;
const RUNNING = ['queued', 'running'];
const REBUILT = 'Set the application URL to the rebuilt twin.';
export const reviewedJourneys = <T extends JourneySelection>(cases: readonly T[] | null | undefined) => (cases || []).filter(item => item.selected && !item.needsReview);

// Settles with the promise, or rejects once the controller shuts down.
function untilStopped<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(conflict('The controller is shutting down.'));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
// The timer ends with the controller, so shutdown never waits out a poll interval.
const pause = (ms: number, signal: AbortSignal | undefined) => delay(ms, undefined, { signal }).catch((error: unknown) => { throw error instanceof Error && error.name === 'AbortError' ? conflict('The controller is shutting down.') : error; });

/** Remembers each ready environment's browser preparation, which the environments manager runs after readiness. */
export function createReadiness(): Readiness {
  const entries = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  function entry(id: string) {
    let value = entries.get(id);
    if (!value) { let resolve!: () => void; value = { promise: new Promise<void>(done => { resolve = done; }), resolve }; entries.set(id, value); }
    return value;
  }
  return { done: id => entry(id).resolve(), wait: id => entry(id).promise, forget: id => { entries.delete(id); } };
}

/**
 * checkout(gate) -> the stage context with the source at gate.sha (409: not now); for a repair gate, the stage context
 *   over gate.snapshot's scan, and the source never moves.
 * readiness: createReadiness(), resolved by the environments manager's onReady hook.
 */
export function createGateSteps<C extends StageContext>({ environments, browser, checkout, checkoutAt, readiness, signal, interval = 2000 }: GateStepsOptions<C>): GateSteps<C, IdleEnvironment, GateRun> {
  return {
    async prepare(gate) {
      const stage = { key: gate.key, stageId: gate.stageId };
      // A person's run or environment operation on this stage finishes first, and every twin of the
      // pipeline, one admitted but not yet recorded too, finishes reading the source before the source can move.
      if (browser.isActive(stage) || environments.admitting(gate.key)
        || environments.summaries(gate.key).some(item => item.stageId === gate.stageId ? IN_PROGRESS.includes(item.status) : readsSource(item))) throw conflict('This stage is busy.');
      return checkout(gate);
    },
    journeys: context => reviewedJourneys(browser.summary(context).cases).length,
    async rebuild(context) {
      await checkoutAt?.(context);
      for (const item of environments.summaries(context.key).filter(item => item.stageId === context.stageId && holdsResources(item))) {
        await environments.destroy(context, item.id);
        const result = await environments.awaitIdle(item.id);
        if (result.status !== 'destroyed') throw new Error(result.error || 'The previous twin could not be deleted.');
      }
      const { environment } = await environments.create(context);
      try {
        const twin = await environments.awaitIdle(environment.id);
        if (twin.status !== 'ready') throw new Error(twin.error || 'The twin did not become ready.');
        // Browser preparation points an automatic application URL at the new twin.
        await untilStopped(readiness.wait(environment.id), signal);
        return twin;
      } finally { readiness.forget(environment.id); }
    },
    async run(context, twin) {
      // A health probe can take the newly ready twin before the browser admits its run, and a person's operation or a
      // model settings save can hold the stage then. Wait for either only; once a run exists, its execution and verdict
      // are never retried.
      let run: { id: string; environmentId?: string };
      for (;;) {
        const { config } = await browser.view(context);
        if (!config.targetUrl || environments.resolveTarget(config.targetUrl)?.id !== twin.id) throw new Error(REBUILT);
        try { ({ run } = await browser.run(context, {})); break; }
        catch (error) { if (!isEnvironmentBusy(error) && !isStageHeld(error)) throw error; await pause(interval, signal); }
      }
      // The browser reads the application URL again as it admits the run, so a URL saved since the check above never
      // lends another application's journeys to this gate's verdict.
      if (run.environmentId !== twin.id) throw new Error(REBUILT);
      for (;;) {
        const { run: current } = await browser.runProgress(context, run.id);
        if (!RUNNING.includes(current.status)) return current;
        await pause(interval, signal);
      }
    },
  };
}
