import test from 'node:test';
import assert from 'node:assert/strict';
import { code, deployManifest, devcontainer, dockerfile, supabaseConfig, turbo, workflow, yamlValue } from '../src/environments/setup-configs.ts';
import { hide, redact } from '../src/redaction.ts';

// A repository's setup files as EVIDENCE.md quotes them: commands, images, ports, versions and paths, and variable names
// with their line, never a value. Every fixture is synthetic.
const VALUE = 'value-never-shown';
const hidden = (text: string) => assert.ok(!text.includes(VALUE), text);

test('workflow evidence redacts a whole multiline command before selecting its run lines', () => {
  const source = [
    'jobs:', '  build:', '    runs-on: ubuntu-latest', '    env:', '      DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}',
    '    steps:', '      - run: |', "          cat <<'EOF'", '          -----BEGIN PRIVATE KEY-----',
    '          PRIVATE_BODY_FIRST', '          PRIVATE_BODY_SECOND', '          -----END PRIVATE KEY-----', '          EOF',
    '          npm run build',
  ].join('\n');
  const result = workflow(source), output = result.lines.join('\n');
  assert.ok(!output.includes('PRIVATE_BODY_FIRST') && !output.includes('PRIVATE_BODY_SECOND'), 'A multiline key body never becomes separate quoted run lines.');
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /npm run build/);
  assert.deepEqual(result.names, [{ name: 'DEPLOY_TOKEN', line: 5 }], 'Names and positions still come from the original workflow.');
});

test('setup readers redact complete commands and metadata before their limits', () => {
  const token = `sk-${'a'.repeat(350)}`, command = `${'x'.repeat(193)} ${token} npm start`;
  const cases = [
    workflow(`jobs:\n  build:\n    runs-on: ${token}\n    steps:\n      - run: ${command}\n`),
    dockerfile(`FROM node:24\nCMD ${command}\n`),
    devcontainer(JSON.stringify({ image: `registry.example/${token}`, postCreateCommand: command })),
    deployManifest('vercel.json', JSON.stringify({ framework: token, buildCommand: command })),
    deployManifest('Procfile', `web: ${command}\n`),
    turbo(JSON.stringify({ tasks: { [token]: { env: ['API_URL'] } } })),
  ];
  for (const result of cases) {
    const output = result.lines.join('\n');
    assert.ok(!output.includes(token.slice(0, 6)), 'No clipped prefix of a token reaches a quoted command or metadata.');
    assert.match(output, /\[REDA/);
  }
});

test('setup readers hide supplied values before command clipping without rewriting semantic facts', () => {
  const secret = `provided-value-${'z'.repeat(350)}`, observe = (text: string) => redact(hide([secret])(text));
  const command = `${'x'.repeat(194)}${secret}`;
  const result = workflow(`jobs:\n  build:\n    runs-on: ubuntu-latest\n    env:\n      SESSION_SECRET: value\n    steps:\n      - run: ${command}\n`, observe);
  const output = result.lines.join('\n');
  assert.ok(!output.includes(secret.slice(0, 6)), 'An arbitrary supplied value is hidden before its full value is lost to clipping.');
  assert.deepEqual(result.names, [{ name: 'SESSION_SECRET', line: 5 }]);
});

test('setup evidence observes variable names without changing their semantic positions', () => {
  const name = 'OPAQUE_NAME_Z_12345678', hidden = hide([name]), observe = (text: string) => redact(hidden(text));
  for (const result of [dockerfile(`FROM node:24\nENV ${name}=value\n`, observe), supabaseConfig(`[auth]\nsecret = "env(${name})"\n`, observe)]) {
    assert.ok(!result.lines.join('\n').includes(name));
    assert.match(result.lines.join('\n'), /\[REDACTED\]/);
    assert.deepEqual(result.names, [{ name, line: 2 }]);
  }
});

test('a workflow gives each job’s runner, services, working directory, variables, setup versions and run lines', () => {
  const long = `echo ${'x'.repeat(300)}`;
  const { lines, names } = workflow([
    'name: CI', 'on: push', 'env:', '  CI_FLAG: 1', 'jobs:', '  test:', '    runs-on: ubuntu-latest',
    '    services:', '      postgres:', '        image: postgres:16', '        ports: ["5432:5432"]', '        env:', `          POSTGRES_PASSWORD: ${VALUE}`,
    '    defaults:', '      run:', '        working-directory: apps/api', '    env:', `      DATABASE_URL: ${VALUE}`,
    '    steps:', '      - uses: actions/checkout@v4', '      - uses: pnpm/action-setup@v4', '        with: { version: 9 }',
    '      - uses: actions/setup-node@v4', '        with:', '          node-version: 22', '          cache: pnpm',
    '      - uses: actions/setup-python@v5', '        with: { python-version: "3.12" }',
    '      - run: pnpm install --frozen-lockfile', '      - name: Test', '        working-directory: apps/web', '        run: |', '          pnpm test', `          ${long}`,
    '        env:', '          API_TOKEN: ${{ secrets.API_TOKEN }}', '          FEATURE: ${{ vars.FEATURE_FLAG }}',
  ].join('\n'));
  assert.deepEqual(lines, [
    '- Variables: CI_FLAG', '- Job `test`: runs on `ubuntu-latest`', '  - Service `postgres`: `postgres:16`, ports 5432:5432; variables POSTGRES_PASSWORD',
    '  - Working directory: `apps/api`', '  - Variables: DATABASE_URL', '  - Steps:', '    - `actions/checkout@v4`', '    - `pnpm/action-setup@v4`; version `9`',
    '    - `actions/setup-node@v4`; node-version `22`; with cache', '    - `actions/setup-python@v5`; python-version `3.12`', '    - run `pnpm install --frozen-lockfile`',
    '    - run; in `apps/web`; variables API_TOKEN, FEATURE:', '      - `pnpm test`', `      - \`${long.slice(0, 200)}…\``,
    '- Secrets and variables it references: API_TOKEN, FEATURE_FLAG',
  ]);
  assert.deepEqual(names, [{ name: 'API_TOKEN', line: 36 }, { name: 'FEATURE_FLAG', line: 37 }, { name: 'CI_FLAG', line: 4 },
    { name: 'POSTGRES_PASSWORD', line: 13 }, { name: 'DATABASE_URL', line: 18 }, { name: 'FEATURE', line: 37 }]);
  hidden(lines.join('\n'));
});

test('a Dockerfile gives its images, working directory, argument and variable names, ports and start command', () => {
  const { lines, names } = dockerfile([
    '# syntax=docker/dockerfile:1', 'ARG NODE_VERSION=22', 'FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build', 'WORKDIR /app',
    `ENV NODE_ENV=production \\`, '    # a comment inside the instruction', `    SESSION_KEY="${VALUE} with=spaces"`, 'RUN <<EOF', 'ENV INSIDE_A_HEREDOC=1', 'EOF',
    `ENV LEGACY_NAME ${VALUE}`, 'FROM nginx:alpine', 'EXPOSE 3000 8080/tcp', 'CMD ["node", "server.js"]',
  ].join('\n'));
  assert.deepEqual(lines, ['- From: `node:${NODE_VERSION}-alpine` as `build`, `nginx:alpine`', '- Workdir: `/app`', '- Args: NODE_VERSION',
    '- Env: NODE_ENV, SESSION_KEY, LEGACY_NAME', '- Expose: 3000, 8080/tcp', '- Cmd: `["node", "server.js"]`']);
  assert.deepEqual(names, [{ name: 'NODE_VERSION', line: 2 }, { name: 'NODE_ENV', line: 5 }, { name: 'SESSION_KEY', line: 5 }, { name: 'LEGACY_NAME', line: 11 }]);
  hidden(lines.join('\n'));
});

test('quoted text, arithmetic and other instructions open no heredoc, and one that never closes leaves the rest read', () => {
  for (const opener of ['RUN echo "usage: tool <<input>> out" > /usage.txt', 'RUN echo $((1 << shift))', 'LABEL description="<<EOF"', 'RUN cat <<NEVER > /notes']) {
    const { lines } = dockerfile(['FROM node:24', opener, 'ENV API_URL=http://api', 'EXPOSE 3000', 'CMD ["node", "server.js"]'].join('\n'));
    assert.deepEqual(lines, ['- From: `node:24`', '- Env: API_URL', '- Expose: 3000', '- Cmd: `["node", "server.js"]`'], opener);
  }
  // A heredoc that closes, its delimiter quoted or not, still hides its body.
  for (const opener of ["RUN <<'EOF' bash", 'COPY <<-"EOF" /app/settings', 'RUN cat <<EOF > /app/notes']) {
    assert.deepEqual(dockerfile(['FROM node:24', opener, 'ENV INSIDE=1', 'EOF', 'ENV AFTER=1'].join('\n')).lines, ['- From: `node:24`', '- Env: AFTER'], opener);
  }
});

test('a devcontainer.json with comments gives its image, features, ports, setup commands and variable names', () => {
  const { lines, names } = devcontainer([
    '{', '  // The development image', '  "image": "mcr.microsoft.com/devcontainers/typescript-node:22",', '  "features": { "ghcr.io/devcontainers/features/node:1": {} },',
    '  "forwardPorts": [3000, 5432],', '  "postCreateCommand": "pnpm install",', '  "postStartCommand": { "db": "pnpm db:up", "web": ["pnpm", "dev"] },',
    `  "containerEnv": { "DATABASE_URL": "${VALUE}" },`, '  /* trailing comma */', '}',
  ].join('\n'));
  assert.deepEqual(lines, ['- Image: `mcr.microsoft.com/devcontainers/typescript-node:22`', '- Features: `ghcr.io/devcontainers/features/node:1`', '- Forwarded ports: 3000, 5432',
    '- postCreateCommand: `pnpm install`', '- postStartCommand: `db` `pnpm db:up`', '- postStartCommand: `web` `pnpm dev`', '- containerEnv: DATABASE_URL']);
  assert.deepEqual(names, [{ name: 'DATABASE_URL', line: 8 }]);
  hidden(lines.join('\n'));
});

test('deploy manifests give their commands, directories, settings and variable names, whatever their format', () => {
  const railway = deployManifest('railway.toml', ['[build]', 'builder = "NIXPACKS"', 'buildCommand = "pnpm build"', '[deploy]', 'startCommand = "pnpm start"', 'healthcheckPath = "/health"'].join('\n'));
  assert.deepEqual(railway.lines, ['- `build.builder`: `NIXPACKS`', '- `build.buildCommand`: `pnpm build`', '- `deploy.startCommand`: `pnpm start`', '- `deploy.healthcheckPath`: `/health`']);
  const render = deployManifest('render.yaml', ['services:', '  - type: web', '    name: api', '    rootDir: api', '    buildCommand: npm ci', '    startCommand: npm start',
    '    envVars:', '      - key: SESSION_SECRET', `        value: ${VALUE}`, '      - key: DATABASE_URL', '        fromDatabase: { name: db, property: connectionString }'].join('\n'));
  assert.deepEqual(render.lines, ['- `services[api].type`: `web`', '- `services[api].rootDir`: `api`', '- `services[api].buildCommand`: `npm ci`',
    '- `services[api].startCommand`: `npm start`', '- `services[api].envVars`: SESSION_SECRET, DATABASE_URL']);
  assert.deepEqual(render.names, [{ name: 'SESSION_SECRET', line: 8 }, { name: 'DATABASE_URL', line: 10 }]);
  const fly = deployManifest('fly.toml', ['app = "fixture"', '[env]', `PUBLIC_URL = "${VALUE}"`, '[processes]', 'app = "node server.js"', '[http_service]', 'internal_port = 8080'].join('\n'));
  assert.deepEqual(fly.lines, ['- `env`: PUBLIC_URL', '- `processes.app`: `node server.js`', '- `http_service.internal_port`: `8080`']);
  const vercel = deployManifest('vercel.json', `{ "framework": "nextjs", "buildCommand": "pnpm build", "outputDirectory": "out", "env": { "API_KEY": "${VALUE}" } }`);
  assert.deepEqual(vercel.lines, ['- `framework`: `nextjs`', '- `buildCommand`: `pnpm build`', '- `outputDirectory`: `out`', '- `env`: API_KEY']);
  assert.deepEqual(deployManifest('Procfile', 'web: npm start\nworker: node worker.js\n').lines, ['- `web`: `npm start`', '- `worker`: `node worker.js`']);
  assert.deepEqual(deployManifest('netlify.toml', ['[build]', 'base = "web"', 'command = "npm run build"', 'publish = "dist"', '[build.environment]', 'NODE_VERSION = "22"'].join('\n')).lines,
    ['- `build.base`: `web`', '- `build.command`: `npm run build`', '- `build.publish`: `dist`', '- `build.environment`: NODE_VERSION']);
  for (const item of [railway, render, fly, vercel]) hidden(item.lines.join('\n'));
});

test('turbo.json gives its tasks and the variables each passes', () => {
  const { lines, names } = turbo('{\n  // v2\n  "globalEnv": ["NODE_ENV"],\n  "tasks": { "build": { "env": ["NEXT_PUBLIC_*", "API_URL"], "passThroughEnv": ["CI_TOKEN"] }, "dev": {} }\n}');
  assert.deepEqual(lines, ['- Tasks: `build`, `dev`', '- Global: env NODE_ENV', '- `build`: env NEXT_PUBLIC_*, API_URL; pass-through CI_TOKEN']);
  assert.deepEqual(names, [{ name: 'NODE_ENV', line: 3 }, { name: 'API_URL', line: 4 }, { name: 'CI_TOKEN', line: 4 }]);
});

test('a Supabase config.toml gives its env() names, functions, seed and enabled sign-in methods', () => {
  const { lines, names } = supabaseConfig(['project_id = "fixture"', '[db.seed]', 'sql_paths = ["./seed.sql"]', '[auth.email]', 'enable_signup = true',
    '[auth.external.github]', 'enabled = true', 'secret = "env(AUTH_GITHUB_SECRET)"', '[auth.external.apple]', 'enabled = false', '[functions.billing]', 'verify_jwt = false'].join('\n'));
  assert.deepEqual(lines, ['- Variables from env(): `auth.external.github.secret` AUTH_GITHUB_SECRET', '- Functions in config: `billing` (verify_jwt `false`)',
    '- Seed: enabled, `./seed.sql`', '- Sign-in enabled: email, external github']);
  assert.deepEqual(names, [{ name: 'AUTH_GITHUB_SECRET', line: 8 }]);
});

test('a YAML file may share one anchor across many entries, and an alias that expands at every level is still refused', () => {
  const services = Array.from({ length: 25 }, (_, index) => `  service-${index}:\n    <<: *defaults\n    image: app:${index}`).join('\n');
  assert.equal(Object.keys((yamlValue(`x-defaults: &defaults\n  restart: always\nservices:\n${services}\n`) as { services: object }).services).length, 25);
  const jobs = Array.from({ length: 25 }, (_, index) => `  job-${index}:\n    runs-on: ubuntu-latest\n    steps: *steps`).join('\n');
  assert.equal(workflow(`x-steps: &steps\n  - run: npm test\njobs:\n${jobs}\n`).lines.filter(line => line === '    - run `npm test`').length, 25);
  // Each level holds ten of the one before: refused long before it is expanded.
  const levels = 'abcdefghi', bomb = [`a: &a [${Array(10).fill('x').join(', ')}]`, ...[...levels.slice(1)].map((name, index) => `${name}: &${name} [${Array(10).fill(`*${levels[index]}`).join(', ')}]`)];
  assert.throws(() => yamlValue(bomb.join('\n')), /alias/i);
});

test('setup files that do not parse are refused by their reader', () => {
  assert.throws(() => workflow('jobs: [unclosed'));
  assert.throws(() => supabaseConfig('[auth'));
  assert.deepEqual(devcontainer('not json').lines, ['- Could not be read.']);
});

test('nixpacks.toml and railpack.json give their build and start commands, settings and variable names', () => {
  const nixpacks = deployManifest('nixpacks.toml', ['[phases.setup]', 'nixPkgs = ["nodejs_22"]', '[phases.build]', 'cmds = ["pnpm install", "pnpm build"]', '[start]', 'cmd = "pnpm start"',
    '[variables]', '# The API origin', `API_ORIGIN = "${VALUE}"`].join('\n'));
  assert.deepEqual(nixpacks.lines, ['- `phases.build.cmds`: `pnpm install`, `pnpm build`', '- `start.cmd`: `pnpm start`', '- `variables`: API_ORIGIN']);
  // A TOML parser keeps no positions: the name's line is where it is a key, not the comment that mentions it first.
  assert.deepEqual(nixpacks.names, [{ name: 'API_ORIGIN', line: 9 }]);
  const railpack = deployManifest('railpack.json', JSON.stringify({ provider: 'node', steps: { build: { commands: ['npm run build'] } },
    deploy: { startCommand: 'node dist/index.js', variables: { SESSION_KEY: VALUE } } }, null, 2));
  assert.deepEqual(railpack.lines, ['- `provider`: `node`', '- `steps.build.commands`: `npm run build`', '- `deploy.startCommand`: `node dist/index.js`', '- `deploy.variables`: SESSION_KEY']);
  assert.deepEqual(railpack.names, [{ name: 'SESSION_KEY', line: 13 }]);
  for (const item of [nixpacks, railpack]) hidden(item.lines.join('\n'));
});

test('a devcontainer.json that builds its image or runs compose files gives them', () => {
  assert.deepEqual(devcontainer('{ "build": { "dockerfile": "Dockerfile", "context": ".." }, "remoteEnv": { "EDITOR_TOKEN": "x" } }').lines,
    ['- Build: dockerfile `Dockerfile`, context `..`', '- remoteEnv: EDITOR_TOKEN']);
  assert.deepEqual(devcontainer('{ "build": {} }').lines, ['- Build: yes']);
  assert.deepEqual(devcontainer('{ "dockerComposeFile": ["../compose.yml", "compose.dev.yml"], "service": "app" }').lines, ['- Compose files: `../compose.yml`, `compose.dev.yml`, service `app`']);
});

test('long lists of manifest entries, env() references and named commands keep their first entries and say how many more', () => {
  const vercel = deployManifest('vercel.json', JSON.stringify({ crons: Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`job${index}`, { buildCommand: `npm run job${index}` }])) }));
  assert.equal(vercel.lines.length, 41);
  assert.deepEqual([vercel.lines[0], vercel.lines[40]], ['- `crons.job0.buildCommand`: `npm run job0`', '- … 5 more left out.']);
  const config = supabaseConfig(`[x]\n${Array.from({ length: 42 }, (_, index) => `k${index} = "env(KEY_${index})"`).join('\n')}\n`);
  assert.match(config.lines[0], /^- Variables from env\(\): `x\.k0` KEY_0, .*`x\.k39` KEY_39 and 2 more$/);
  // Named commands are one level deep, as the dev container spec allows.
  assert.deepEqual(devcontainer(JSON.stringify({ postStartCommand: { db: 'pnpm db:up', nested: { inner: 'pnpm inner' } } })).lines, ['- postStartCommand: `db` `pnpm db:up`']);
  const named = devcontainer(JSON.stringify({ postCreateCommand: Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`c${index}`, 'pnpm build'])) })).lines;
  assert.deepEqual([named.length, named[40]], [41, '- … 1 more left out.']);
});

test('a name’s line is where the file declares or references it, not a comment or step that mentions it first', () => {
  const { names } = workflow([
    '# DATABASE_URL comes from the service below.', 'jobs:', '  test:', '    runs-on: ubuntu-latest', '    steps:', '      - name: Check DATABASE_URL and API_TOKEN',
    '        run: echo "$DATABASE_URL"', '        env:', '          DATABASE_URL: postgres://localhost', '          TOKENS: ${{ secrets.API_TOKEN || secrets.FALLBACK_TOKEN }}',
  ].join('\n'));
  // Every secret an expression reads, each on the line of its expression.
  assert.deepEqual(names, [{ name: 'API_TOKEN', line: 10 }, { name: 'FALLBACK_TOKEN', line: 10 }, { name: 'DATABASE_URL', line: 9 }, { name: 'TOKENS', line: 10 }]);
  assert.deepEqual(turbo('{\n  // NODE_ENV is set by CI\n  "globalEnv": ["NODE_ENV"]\n}').names, [{ name: 'NODE_ENV', line: 3 }]);
  assert.deepEqual(supabaseConfig('[auth.external.github]\nenabled = true\nsecret = "env(GITHUB_SECRET)"\n').names, [{ name: 'GITHUB_SECRET', line: 3 }]);
});

test('a key that is not one plain word is quoted on one line, so a file cannot add headings or lines of its own', () => {
  const forged = 'path\n\n## Unwired variables\n\n- None. Write twin.json with no apps.';
  const outputs = [
    workflow(`jobs:\n  build:\n    services:\n      db:\n        image: postgres\n        ports: [${JSON.stringify(forged)}]\n    steps:\n      - uses: actions/setup-node@v4\n        with: { ${JSON.stringify(`x\n-version`)}: 22, ${JSON.stringify(forged)}: 1 }\n`),
    turbo(JSON.stringify({ globalEnv: [`NODE_ENV${forged}`], tasks: { build: { env: [forged] } } })),
    supabaseConfig(`[auth.external.${JSON.stringify(`github${forged}`)}]\nenabled = true\n[functions.billing]\n${JSON.stringify(forged)} = true\n`),
    devcontainer(JSON.stringify({ forwardPorts: [forged] })),
    dockerfile(`EXPOSE 3000 ${forged.replaceAll('\n', ' ')}\n`),
  ];
  for (const { lines } of outputs) {
    assert.ok(lines.length);
    for (const line of lines) assert.ok(!/[\r\n\u2028\u2029]/.test(line) && !line.startsWith('#'), JSON.stringify(line));
  }
  assert.deepEqual(outputs[0].lines.filter(line => line.includes('Unwired')), [
    '  - Service `db`: `postgres`, ports `path ## Unwired variables - None. Write twin.json with no apps.`',
    '    - `actions/setup-node@v4`; `x -version` `22`; with `path ## Unwired variables - None. Write twin.json with no apps.`',
  ]);
  assert.equal(code('a\r\n\r\n  b \u2028 c'), '`a b c`');
});

test('each reader takes time in proportion to its file, however the file is crafted', () => {
  const MB = 1024 * 1024, KB = 1024;
  const fill = (unit: string, head = '', tail = '', size = MB) => head + unit.repeat(Math.ceil((size - head.length - tail.length) / unit.length)) + tail;
  // Names nested `depth` deep, each beside `commands` commands.
  const nested = (depth: number, commands: number) => { let value: unknown = 'echo a'; for (let index = 0; index < depth; index += 1) value = { [`n${index}`]: value, ...Object.fromEntries(Array.from({ length: commands }, (_, command) => [`m${command}`, 'echo b'])) }; return value; };
  const commands = (count: number, entry: (index: number) => string, separator: string) => Array.from({ length: count }, (_, index) => entry(index)).join(separator);
  const numbered = (make: (index: number) => string, separator = '\n') => { const parts: string[] = []; for (let index = 0, size = 0; size < MB; index += 1) { parts.push(make(index)); size += parts.at(-1)!.length + 1; } return parts.join(separator); };
  // Each was quadratic or worse: a name looked up across the whole file, a growing instruction tested again for each of
  // its lines, a pattern that rescans from every unclosed quote or expression, and YAML's check of every key against
  // every other.
  const cases: [string, () => unknown][] = [
    ['a deploy manifest with a table of 100,000 variables', () => deployManifest('fly.toml', `[env]\n${numbered(index => `KEY_${index} = "v"`)}`)],
    ['a Dockerfile with 100,000 continued lines', () => dockerfile(fill('RUN a \\\n'))],
    ['a Dockerfile with a string that never closes', () => dockerfile(fill('\\"', 'ARG A="'))],
    ['a Dockerfile with single quotes that never close', () => dockerfile(fill("'", 'ENV A='))],
    ['a RUN instruction with a string that never closes', () => dockerfile(fill('\\"', 'RUN echo "'))],
    ['a Dockerfile with 100,000 heredocs that never close', () => dockerfile(numbered(index => `RUN cat <<E${index}`))],
    ['a workflow with 100,000 variables', () => workflow(`env:\n${numbered(index => `  KEY_${index}: v`)}\njobs: {}\n`)],
    ['a workflow with expressions that never close', () => workflow(fill('${{ ', 'env:\n  A: "', '"\n'))],
    ['a workflow with a value of spaces', () => workflow(`jobs:\n  build:\n    container: "a${' '.repeat(MB)}b"\n`)],
    ['a dev container with 100,000 variables', () => devcontainer(`{ "containerEnv": { ${numbered(index => `"KEY_${index}": "v"`, ',')} } }`)],
    ['a turbo.json with 100,000 variables', () => turbo(`{ "globalEnv": [${numbered(index => `"KEY_${index}"`, ',')}] }`)],
    ['a Supabase config with 100,000 references', () => supabaseConfig(`[x]\n${numbered(index => `k${index} = "env(KEY_${index})"`)}`)],
    // A YAML error formatted against the whole source, a long instruction tested again for each comment row inside it,
    // and a long key or deep names formatted again for every entry beneath them, each in a file the reader takes.
    ['a workflow of tags that do not parse', () => assert.throws(() => workflow(fill('!a ', '', '', 256 * KB)))],
    ['a workflow of quotes that do not parse', () => assert.throws(() => workflow(fill('"', '', '', 256 * KB)))],
    ['a Dockerfile whose continued line is followed by 65,536 comment rows', () => dockerfile(`RUN ${'\\a'.repeat(32 * KB)}\\\n${'#\n'.repeat(64 * KB)}`)],
    ['a deploy manifest whose 100 KB key holds 9,000 commands', () => deployManifest('vercel.json', `{"${'k'.repeat(100 * KB)}":{${commands(9000, index => `"c${index}Cmd":"x"`, ',')}}}`)],
    ['a Supabase config whose 100 KB table holds 9,000 references', () => supabaseConfig(`[${'k'.repeat(100 * KB)}]\n${commands(9000, index => `r${index} = "env(A${index})"`, '\n')}\n`)],
    ['a 240 KB dev container whose 16,500 commands are named 1,500 deep', () => devcontainer(JSON.stringify({ postCreateCommand: nested(1500, 11) }))],
  ];
  for (const [name, read] of cases) {
    const started = performance.now();
    read();
    assert.ok(performance.now() - started < 3000, `${name}: ${Math.round(performance.now() - started)} ms`);
  }
});
