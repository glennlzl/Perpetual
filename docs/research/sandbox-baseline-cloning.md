# Prepared Sandbox baselines and independent clones

Researched 2026-10-08 against official documentation and repositories. Updated after the user reaffirmed the established open-source, self-hostable OpenSandbox + Docker choice. Whole-environment cloning remains a recommendation. A first optimization for verified configuration reuse is described below. No vendor environment was provisioned or vendor clone benchmarked.

## Observed local cost and first implementation

The running controller's step timings showed two configuration-authoring attempts totaling 1,300.964 seconds (21 minutes 41 seconds), dependency setup totaling approximately 84 seconds, and dependency installation approximately 29 seconds. Application builds were still in progress when sampled. This is one observed preparation, not a percentile or a complete cold-start benchmark; the timer reports elapsed time, not API charges or CPU consumption.

The first implementation reuses a sibling Sandbox stage's verified generated config for the same pipeline, commit and copied source hash. It retains fresh provisioning, data and readiness checks for each stage. Saved configs, pending drafts, different source content, repair environments and ambiguous candidates cannot be replaced by reuse. The bounded existing records supply candidates, so this adds neither a running warm pool nor a separate disk cache.

A regression test reproduced two configuration-author invocations for two identical-source stages before the change, and one afterward, including a controller restart. This establishes eliminated duplicate authoring, not a measured 21-minute saving for every project. Initial configuration authoring, dependency setup and application builds remain; this change alone does not meet the 60-second complete-environment target.

## Recommendation

Keep **OpenSandbox + Docker** as the selected execution architecture. Use one clean, versioned baseline for compatible Sandbox stages, then create independent instances on demand. The earlier recommendation to start with hosted E2B missed the established deployment constraint and is withdrawn. Hosted products below are reference evidence only, not a proposed migration.

For the Docker path, prepare reusable application images or filesystem snapshots, separately prepare consistent clean service data, then launch each stage with its own writable storage and correct instance-specific bindings. Installation and application builds should happen before stage acquisition wherever the application's configuration permits reuse. Do not create and keep all stage instances running just to make later stages fast.

The 60-second objective applies to acquiring a usable instance from an already prepared baseline. It does not establish a 60-second limit for discovering an unfamiliar repository, generating its environment configuration, downloading dependencies and building a new commit. Those operations still need to happen ahead of demand. Track baseline preparation time, cache-hit rate and instance readiness separately.

Stages retain their own reviewed journeys, results and promotion rules. They can share the same baseline when their infrastructure and initial data requirements match. Each stage starts from that clean baseline, rather than cloning the previous stage after its tests have modified it. Different required configurations or fixtures produce different baseline versions.

## Existing OpenSandbox capabilities

Current upstream OpenSandbox documents Docker-backed persistent snapshots stored as local images and startup from those snapshots. Its Docker snapshot implementation calls `container.commit()`. This is a concrete existing filesystem reuse mechanism, not a full running Compose stack or process-memory clone. [Docker architecture](https://open-sandbox.ai/architecture/#_4-1-docker-runtime), [Snapshot implementation](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/opensandbox_server/services/docker/snapshot_runtime.py)

The CLI supports `osb snapshot create` and `osb sandbox create --snapshot-id`. Its separate template-management path requires a Kubernetes-backed runtime; do not infer Docker support for the FastSandbox microVM/template features from their shared API terminology. Docker pause/resume freezes and resumes the same containers, which is different from creating independent durable copies. [CLI](https://open-sandbox.ai/cli/), [Runtime boundaries](https://open-sandbox.ai/architecture/)

Docker container commits omit mounted-volume data. Perpetual's workspace and database volumes therefore need an explicit baseline/restore design, with service-consistent capture and fresh writable destinations. A reusable image alone does not establish complete environment cloning. [Docker commit limitations](https://docs.docker.com/reference/cli/docker/container/commit/)

These are current upstream capabilities. The inspected checkout documents and implements a Compose twin runtime; this research did not establish an installed OpenSandbox version or existing SDK integration. Confirm the actual integration/version before selecting an upstream API for implementation.

## Comparison evidence

| Solution | Documented capability | Fit and remaining work |
| --- | --- | --- |
| E2B templates and snapshots | Template preparation can start the application, wait for a readiness command, then capture the filesystem and running processes. An official Docker Compose example exists. | Reference for prewarming semantics; not selected under the existing deployment constraint. [Start and readiness](https://docs.e2b.dev/template/start-ready-command), [Compose example](https://docs.e2b.dev/template/examples/docker) |
| Daytona VM hot snapshots and fork | VM sandboxes can capture disk and memory; forks have their own identity and lifecycle. Container sandboxes do not offer the same memory preservation. | Reference for full-state cloning; not selected for this Docker implementation. [Persistence](https://www.daytona.io/docs/en/persistence/), [Fork](https://www.daytona.io/docs/en/sandboxes/#fork-sandboxes) |
| Vercel Sandbox snapshots | Reusable filesystem snapshots, sandbox fork and Docker support. Running processes must be restarted after stop/resume. | Useful if restarting our stack is sufficiently fast; does not provide the same ready-process template behavior. Uncached snapshots can take longer to restore. [Snapshots](https://vercel.com/docs/sandbox/concepts/snapshots), [Docker support](https://vercel.com/changelog/run-docker-containers-inside-vercel-sandbox), [Official lifecycle guidance](https://github.com/vercel/vercel-plugin/blob/main/skills/vercel-sandbox/SKILL.md) |
| Existing local Docker Compose | Cached application image builds and separate Compose project names provide reusable artifacts and resource isolation. | Lowest runtime migration cost, but database capture/restore and environment addressing still need implementation. A container commit excludes mounted volumes. [Build cache](https://docs.docker.com/build/cache/), [Project isolation](https://docs.docker.com/compose/how-tos/project-name/), [Commit limitations](https://docs.docker.com/reference/cli/docker/container/commit/) |

E2B explicitly recommends templates over runtime snapshots when the environment can be defined reproducibly, citing prefetching and resource behavior. This is supporting evidence for preparing reusable state in advance, not a recommendation to adopt its runtime. [Template and snapshot comparison](https://docs.e2b.dev/sandbox/snapshots)

Other candidates examined: CodeSandbox exposes VM fork and hibernation, but its public capabilities alone do not establish compatibility with this entire Compose workload. Modal offers memory snapshots in Alpha, with restrictions including external volumes and restoration of background processes started through exec. These are comparison evidence only. [CodeSandbox SDK](https://codesandbox.io/sdk), [Modal snapshot restrictions](https://modal.com/docs/guide/sandbox-snapshots)

## What the timing evidence establishes

Daytona's official small Python example reports approximately 1.78 seconds p50 from live fork to a usable environment, versus approximately 74 seconds for its first snapshot build. That demonstrates the distinction between preparation and acquisition. It is not a full web application with authentication, several Compose services and real test fixtures, and is not a Perpetual p95 guarantee. [Measured example](https://www.daytona.io/docs/en/guides/reinforcement-learning/hud-rl-cookbook/)

No source reviewed establishes that any arbitrary Perpetual twin will become usable within 60 seconds. The documented mechanisms make that a reasonable target for compatible prepared environments; workload measurements must determine whether it is met.

## Fit with the current implementation

The current [twin runtime](../../src/twin/runtime.ts) performs service setup, installation, fixture creation, application builds and Compose startup for each environment. Its [architecture](../architecture/twins-and-gate.md) shares package downloads but does not provide an already built, clonable application baseline. Application outputs and service data use storage that cannot be assumed to be included in a Docker container image.

The existing [addressing contract](../twins.md) allocates public addresses before application builds. Some applications compile these addresses into browser bundles or use them for authentication callbacks. A clone must have correct instance-specific addressing; changing the displayed URL alone does not fix compiled bundles or callback configuration. Applications requiring a new build for every origin may need a different baseline boundary. A gateway or runtime configuration can help where the application supports it, but is not a universal fix.

E2B has a particularly relevant constraint: variables supplied when a sandbox is created do not update processes already captured in a template. Instance-specific configuration requires an explicit reload/restart or compatible routing arrangement. Include that work in the readiness timer. [Process configuration](https://docs.e2b.dev/template/start-ready-command)

Nested Docker named-volume data may be captured when its backing storage is on the guest's snapshotted disk. That is an inference, not an independently verified whole-Compose guarantee. Test it with the exact runtime, storage layout and database workload. E2B's separately attached volumes are shared external resources and currently have no volume snapshot or server-side copy operation. Do not use the same writable external volume for supposedly independent clones. [Volume limitations](https://docs.e2b.dev/faq/volumes-beta-limitations)

Hosted external services are not copied by a VM snapshot. Their test accounts, data namespaces, listeners and callbacks need instance-aware setup or reset. Missing service authorization remains a blocker; a snapshot cannot supply it. Preserve the project's [twin fidelity rules](../twins.md), and capture clean test data rather than production credentials or data.

## Local versus hosted deployment

E2B Embed provides a single-host deployment, but requires Linux KVM. Its documented Apple silicon path needs a suitable Mac and an additional Linux VM with nested virtualization. It is not a drop-in extension of the current Docker Desktop engine. [Embed requirements](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md)

Daytona's public repository states that core development moved private in June 2026 and the old public core is no longer maintained or supported. Do not select the current hosted feature set on the assumption that it is available in a maintained open-source local distribution. [Repository notice](https://github.com/daytonaio/daytona)

The deployment scope is already decided: preserve open-source self-hosting on Docker. Prioritize OpenSandbox's Docker snapshot/image capabilities plus the Compose application's independently restored test data. MicroVM and managed-cloud paths are outside this optimization's scope.

## Baseline identity and lifecycle

Proposed identity: repository and root directory, exact commit, environment definition, dependency/runtime versions and architecture, initial fixture definition, and relevant configuration versions. Stage name alone does not belong in that identity. Store credential references or versions rather than secret values in identifying metadata.

Prepare a baseline when explicitly requested or as part of the authorized push/gate flow. Mere page opening or controller restart must not start paid preparation. Record baseline ownership and expiry separately from the instances that reference it. Deleting a stage removes its owned instances, while a shared baseline remains until no active consumer needs it and its retention rule permits removal.

The acquisition path becomes: resolve the exact prepared baseline, create an independent instance, apply instance-specific bindings, then verify application and dependency readiness. Acquisition failure or a cache miss must remain visible. Do not silently use an older commit or treat runtime readiness as a passed business journey.

## Smallest decisive experiment

1. On the selected Docker runtime, prepare one representative multi-service application at an exact commit. Retain its reusable application artifacts and separately capture service-consistent clean test data; do not assume container snapshots include mounted volumes.
2. Create two independent instances. Measure request to correct application URL, dependency readiness and usable fixtures. Count post-restore configuration and reconnection time.
3. Modify data in one instance and verify the other instance and a later fresh clone retain the baseline state. Delete one instance and verify the other remains usable.
4. Verify each instance's actual sign-in/callback path and a representative complete journey through the existing reviewed execution flow. Keep this acceptance evidence separate from environment readiness.
5. Repeat enough acquisitions to report p50 and p95, including uncached restores, concurrency and realistic data sizes. Separately record cold preparation duration and baseline-hit rate.

Proceed with baseline reuse in the existing runtime only if this experiment meets the 60-second target and preserves isolation. The research does not establish account-specific feature access, operational cost or a production SLA.
