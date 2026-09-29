// A function-local deno.json maps a directory with imported child files, the dependency shape reported in supabase/cli#6505.
// This is a compatibility fixture; an earlier legacy import-map variant did not reproduce that upstream failure on 2.117.0.
export const supabaseEdgeFiles: Record<string, string> = {
  'supabase/config.toml': `project_id = "acme-edge"
[api]
enabled = true
[db]
major_version = 17
[db.migrations]
enabled = false
[db.seed]
enabled = false
[studio]
enabled = false
[analytics]
enabled = false
[edge_runtime]
enabled = false
[functions.hello]
verify_jwt = false
`,
  'supabase/functions/hello/deno.json': JSON.stringify({ imports: { '@acme/shared/': '../../packages/shared/' } }),
  'supabase/functions/hello/index.ts': `import { message } from '@acme/shared/index.ts';
import { suffix } from '@acme/shared/detail.ts';
Deno.serve(() => Response.json({ message, suffix }));
`,
  'supabase/packages/shared/index.ts': `import { suffix } from './detail.ts';
export const message = 'hello ' + suffix;
`,
  'supabase/packages/shared/detail.ts': `export const suffix = 'acme';
`,
};

// Keep the legacy configuration that booted but returned BOOT_ERROR before the isolated Deno bridge.
export const supabaseLegacyEdgeFiles: Record<string, string> = {
  ...supabaseEdgeFiles,
  'supabase/config.toml': `${supabaseEdgeFiles['supabase/config.toml']}import_map = "./functions/import_map.json"\n`,
  'supabase/functions/import_map.json': JSON.stringify({ imports: { '@acme/shared/': '../packages/shared/' } }),
};
delete supabaseLegacyEdgeFiles['supabase/functions/hello/deno.json'];
