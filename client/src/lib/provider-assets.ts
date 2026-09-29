// Local provider marks in public/assets/providers. Colored marks keep their
// source colors; only monochrome marks invert on dark surfaces.
const ASSETS: Record<string, string> = { github: 'github', vercel: 'vercel', railway: 'railway', stripe: 'stripe', supabase: 'supabase', langgraph: 'langgraph', composio: 'composio', 'trigger.dev': 'triggerdotdev', 'trigger-dev': 'triggerdotdev', 'next.js': 'nextdotjs', hono: 'hono' };
const COLORED = new Set(['stripe', 'supabase', 'hono', 'langgraph', 'triggerdotdev']);

export const providerAsset = (provider: unknown): string | undefined => ASSETS[String(provider || '').toLowerCase()];
export const monochromeAsset = (asset: string) => !COLORED.has(asset);
