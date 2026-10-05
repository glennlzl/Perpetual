# Desktop sandbox (experimental)

The `perpetual sandbox` CLI creates an owned local Linux desktop with [Cua](https://github.com/trycua/cua), for desktop applications. It is experimental and optional: web applications run as [Compose twins](twins.md), and [business journeys](journeys.md) use a local browser worker that needs neither Docker nor Cua. The Pipeline does not create Cua desktops.

The adapter was reviewed against [trycua/cua commit 912a4550b72a770f3a21e1f3453961a9eca9de08](https://github.com/trycua/cua/tree/912a4550b72a770f3a21e1f3453961a9eca9de08), covering the sandbox lifecycle and transports, the Linux Docker defaults, shell, files and screenshots, Cua Driver and MCP, recording and licensing. It is not a review of every file or every OS and cloud backend.

```text
Perpetual CLI (`perpetual sandbox`)
  ├─ owned local Docker lifecycle → Cua Linux desktop + computer-server
  ├─ Python Sandbox SDK 0.8.0 → guest shell, files, screenshot, input
  └─ persistent docker exec stdio → guest Cua Driver 0.28.2 MCP
                                      └─ browser / desktop / recording tools
```

Implementation: [`src/sandbox/cua-local.ts`](../src/sandbox/cua-local.ts), [`src/sandbox/cua.ts`](../src/sandbox/cua.ts), [`integrations/cua/bridge.py`](../integrations/cua/bridge.py) and the `sandbox` commands in [`src/cli.ts`](../src/cli.ts).

A desktop persists until it is explicitly destroyed. `integrations/cua/Dockerfile` builds a desktop image with the pinned Driver for `--image`; nothing builds it automatically. The sandbox does not provision databases or provider resources and does not enforce release gates.

## Usage

Requirements: Node 24.12 or later, a local Docker engine running Linux containers, Python 3.11–3.13 and `uv` for the SDK bridge. The adapter rejects remote TCP or SSH Docker endpoints. Guest image and CPU architecture compatibility need checking on each machine.

```sh
# Install the host SDK environment; this does not start a desktop.
uv sync --project integrations/cua --frozen

# Returns an ID and local API and desktop endpoints once computer-server is ready.
node src/cli.ts sandbox create [--image IMAGE] [--cpus 2] [--memory 4096]
node src/cli.ts sandbox list
node src/cli.ts sandbox inspect --id ID

# Commands run inside the owned desktop, not in the original repository.
node src/cli.ts sandbox exec --id ID --command 'pwd'
node src/cli.ts sandbox screenshot --id ID --output /tmp/cua-desktop.png

# Explicit single-file transfer, at most 8 MiB; a local output file is never overwritten.
node src/cli.ts sandbox upload --id ID --input /tmp/fixture.json --to /tmp/fixture.json
node src/cli.ts sandbox download --id ID --from /tmp/result.json --output /tmp/cua-result.json

# Basic guest input without Driver. It is not a business assertion.
node src/cli.ts sandbox act --id ID --action '{"type":"keypress","keys":["ctrl","l"]}'

node src/cli.ts sandbox destroy --id ID
```

Use the same absolute `--data` directory for every command. `list` returns saved records, which may be stale; `inspect` checks the actual Docker resource. A failed creation keeps its record, including any cleanup failure. Output files and metadata are private by default. `PERPETUAL_CUA_PYTHON` can name an absolute Python executable whose environment has the pinned SDK.

### Driver MCP

`sandbox mcp` connects an agent to Cua Driver **inside** the owned desktop. The guest image must contain Driver **0.28.2**, its Linux runtime dependencies, a working graphical session and the browser the task uses. The default Driver path is `/usr/local/bin/cua-driver` and the default guest UID is `1000`; do not assume the upstream base image satisfies these requirements.

```sh
node src/cli.ts sandbox mcp --id ID \
  --driver-path /usr/local/bin/cua-driver --user 1000 \
  --data /absolute/path/to/.perpetual
```

In an agent's MCP configuration, use `node` as the command and this invocation as its arguments. Keep the process open: it forwards stdio to the guest Driver. Closing MCP ends the control session without destroying the desktop. The process uses Driver's standard permission mode, never its bypass mode, and there is no fallback to the host's desktop. No API keys, production environment variables or host browser profiles are copied into the guest. Recordings and browser actions are started by the MCP client, not by this CLI.

### Bridge validation

```sh
node scripts/validate-cua-bridge.ts --id ID --output /tmp/cua-bridge-checks [--data /absolute/path/to/.perpetual]
```

This checks one existing desktop after a change to the adapter, bridge or guest image: SDK shell output and exit codes, an exact single-file roundtrip through a guest fixture it then removes, a screenshot, and Driver MCP initialization, tool discovery and read-only observations. It writes `report.json` and its evidence to a new directory under `--output`, neither creates nor destroys a desktop, and exits 1 when a check fails.

## Upstream behaviour the adapter handles

| Module | Role | Perpetual use |
| --- | --- | --- |
| `cua-sandbox` | Lifecycle factories, runtime selection, transports and computer interfaces | Pinned to 0.8.0 and attached explicitly to Perpetual's own loopback computer-server; never `Localhost` or implicit cloud selection. |
| DockerRuntime and images | Linux desktop image and port conventions | Cua's image and protocol, behind Perpetual's own Docker lifecycle wrapper for local bindings, ownership, limits and confirmed deletion. |
| Cua Driver | Desktop and browser inspection and actions; CLI, stdio MCP and bindings | Runs inside the guest; a version check requires 0.28.2. The MCP client still negotiates the actual tools. |
| `cua-agent` | A model-driven computer-use loop | Not used; the caller supplies the agent and model. |
| Fleet and pools | Cloud capacity | Not used; no credentials or paid pools. SDK packaging still depends on a Fleet native wheel. |
| Lume, QEMU and other runtimes | OS-specific VM backends | Not used. Local Linux containers are not equivalent to a hardened VM fleet. |

Findings from the review that shaped the adapter:

1. **Local Driver cannot use `sandbox.driver.connect()`.** That accessor requires `FleetTransport`; ordinary Docker uses `HTTPTransport`, and the optional `[driver]` extra is not a local bridge. Perpetual launches `cua-driver mcp` through `docker exec -i` in its verified container.
2. **The upstream Docker defaults need a wrapper.** At the reviewed commit, DockerRuntime publishes ports without a loopback address, removes a same-name container before starting, and does not apply CPU and memory options. The wrapper uses random names, ownership labels, explicit CPU, memory and PID limits, no host mounts and Docker-assigned loopback ports, and resolves the image to an immutable local image ID before creating a container.
3. **Disconnect is not destroy.** Leaving `Sandbox.connect(...)` only disconnects, and SDK destroy does not own a container reached by URL. Perpetual deletes only resources matching its saved ID and owner labels, and confirms their absence through Docker before reporting deletion. A failed cleanup stays recorded.
4. **A failed response must not replay an action or become false success.** HTTPTransport retries `/cmd` on 5xx, including shell mutations, and file helpers fill missing response fields with empty defaults. The bridge uses an explicit checked transport: one request, a bounded response, preserved exit codes and logs, and strict file-result validation. It overrides the transport's `_cmd` boundary, so review that on upgrades. computer-server answers a command it stopped at its time limit, or could not run, with `success: false` and a placeholder exit code such as -1; the bridge reports that as a command that did not finish, never as an exit code. A timeout is an unknown outcome, never permission to repeat.
5. **Published versions differ across layers.** Sandbox is 0.8.0 and Driver 0.28.2, while Sandbox's `[driver]` extra pins 0.27.0; Perpetual does not install that extra. The host SDK is isolated in `integrations/cua/.venv`, and `integrations/cua/uv.lock` records its resolved dependencies. The lock does not pin the guest's packages or mutable base images.
6. **An image name does not prove readiness.** The SDK defaults to `public.ecr.aws/k5j5w0x5/cua-ubuntu-24.04:docker-latest`, with the API on 8000 and the desktop on 6080. `create` checks computer-server readiness only; the Driver command checks its version separately. Custom images must keep the port and protocol contract, and image-ID pinning does not stop a guest startup script from downloading changing packages.

## Recording

Through guest MCP, recording uses `start_recording({output_dir, record_video: true})`, `get_recording_state({})`, then `stop_recording({})`. Check tool errors **and** `video_active` and `last_error`: a recording session can start without video. Linux video needs ffmpeg. Stop and flush first, collect the files, then close MCP and destroy the desktop. A missing capture file is neither a test failure nor a successful recording. Keep one recorder per guest. The 8 MiB file helper is not a video uploader.

Driver element references belong to one capture: observe again after a meaningful state change and never replay old references as a script. Background trusted input depends on the platform; an unsupported trusted action is not a successful native click.

## Limits

- A desktop provides a computer, not dependencies: it does not reproduce payment, mail or database semantics or production state. Recreating a container resets its own filesystem, not remote services. SDK snapshots are not implemented for this local transport.
- There is no automatic expiry, database sidecar, outbound network isolation, restorable snapshot or CPU architecture emulation choice. Loopback publishing keeps the API and desktop ports from other machines only. Perpetual adds no credential to either port, and at the reviewed commit computer-server authenticates only Cua cloud containers and accepts requests from any browser origin, so any local process, or a web page open in a browser on this machine that finds the port, can run commands in the guest or watch its desktop. Destroy a desktop you no longer use. Loopback publishing also does **not** stop the guest from reaching the internet, host services or a production URL you supply. Run trusted workloads only.
- The Driver MCP path has been exercised for protocol discovery and read-only calls, not for every tool.

## Licenses and upgrades

Cua's core repository and Cua Bench use MIT licenses. Optional components and model artifacts have their own terms: the optional legacy `cua-som` package is AGPL-3.0, and perception and model distributions need their third-party notices reviewed. Perpetual does not vendor upstream source, bundle models or install those extras. Docker base images have their own distribution terms. [Core license](https://github.com/trycua/cua/blob/912a4550b72a770f3a21e1f3453961a9eca9de08/LICENSE.md), [perception notices](https://github.com/trycua/cua/blob/912a4550b72a770f3a21e1f3453961a9eca9de08/libs/cua-driver/docs/perception-third-party-notices.md).

Before upgrading, record the new source commit, compare package, Driver and image versions, and recheck HTTP response and retry behaviour, local-versus-Fleet Driver restrictions, image entrypoint dependencies and ports, MCP protocol negotiation, guest permissions, recording evidence and cleanup failures. Keep `CUA_VERSIONS` in `src/sandbox/cua.ts`, `integrations/cua/pyproject.toml`, `uv.lock`, the bridge's version guard and this document in sync.
