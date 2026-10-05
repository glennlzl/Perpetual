# Security policy

## Supported versions

Security fixes land on the latest `main`. Older commits and forks are not patched.

## Reporting a vulnerability

Report vulnerabilities privately. Do not open a public issue, discussion or pull request.

1. Open the repository's [Security tab](https://github.com/willlzl/Perpetual/security).
2. Choose **Report a vulnerability** (GitHub private vulnerability reporting).
3. Include the affected commit, the steps to reproduce and the impact.

The report stays private between you and the maintainer until a fix is released.

## Scope

- The controller (`perpetual serve`) listens on `127.0.0.1` only and accepts same-origin requests with a loopback `Host` header. Every API request needs its launch secret, which the data directory keeps in a file only your user can read and a local tool sends in a header. A browser holds a secret derived from it instead, which the launch link `serve` prints carries in its fragment: the page keeps it in its own origin's storage and sends it in a header. No credential is a cookie, which a browser also sends to every other port on the host, a twin's app included. Changes from the page also carry its session token. The interface's static files hold no secret and are public. The printed link and the browser's storage for the controller's address keep the browser's secret until the launch secret file is removed. A way to reach or drive the API without either secret, or from another origin or host, is in scope.
- Twins publish their ports on `127.0.0.1` only. The exception is the `supabase` service: the Supabase CLI starts its own local stack and publishes its ports itself, and Perpetual does not limit them to loopback.
- A way for an API key or GitHub token held by the controller to reach the interface, logs, recordings or a twin is in scope. One exception is deliberate: by default the `llm` twin service gives the twin's apps the App Settings OpenRouter key, so the twinned repository's code can use it; with `source: app` the service uses the app's own development values instead.
- Perpetual runs the code of the repositories you twin, and approved journey code runs on your machine. Only twin repositories and approve journey code you trust; running untrusted code this way is not a vulnerability in Perpetual.
- Vulnerabilities in dependencies belong upstream, unless the way Perpetual uses them makes them exploitable.
