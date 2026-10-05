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

- The controller (`perpetual serve`) listens on `127.0.0.1` only. It accepts same-origin requests with a loopback `Host` header, and changes need the page's session token. A way to reach or drive it from another origin or host is in scope.
- Twins publish their ports on `127.0.0.1` only. The exception is the `supabase` service: the Supabase CLI starts its own local stack and publishes its ports itself, and Perpetual does not limit them to loopback.
- A way for an API key or GitHub token held by the controller to reach the interface, logs, recordings or a twin is in scope. One exception is deliberate: by default the `llm` twin service gives the twin's apps the App Settings OpenRouter key, so the twinned repository's code can use it; with `source: app` the service uses the app's own development values instead.
- Perpetual runs the code of the repositories you twin, and approved journey code runs on your machine. Only twin repositories and approve journey code you trust; running untrusted code this way is not a vulnerability in Perpetual.
- Vulnerabilities in dependencies belong upstream, unless the way Perpetual uses them makes them exploitable.
