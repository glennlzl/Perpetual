# Asset provenance

The interface's assets are local: the UI does not request logos or fonts from third-party CDNs at runtime. No provider logo is an invented approximation. Third-party marks identify integrations; they do not imply endorsement. Repository licenses do not grant trademark rights.

## Perpetual identity

These four SVGs are the Perpetual project's own identity:

- `public/assets/brand/perpetual-lockup-light.svg`
- `public/assets/brand/perpetual-lockup-dark.svg`
- `public/assets/brand/perpetual-mark-small-light.svg`
- `public/assets/brand/perpetual-mark-small-dark.svg`

Rights remain with the Perpetual project; they are not third-party stock logos. The names describe the **mark color**: `-light.svg` is the light-colored logo for a dark background, and `-dark.svg` is the dark-colored logo for a light background.

## Provider logos

These SVG geometries come from the official [Simple Icons repository](https://github.com/simple-icons/simple-icons), pinned at commit `b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76`. GitHub, Vercel, Railway, Next.js and OpenRouter are exact, unmodified downloads. Stripe, Supabase, Hono and LangGraph keep their original paths, titles and viewBoxes, with a root `fill` taken from the brand's `hex` field in the [same revision's metadata](https://raw.githubusercontent.com/simple-icons/simple-icons/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/data/simple-icons.json) and a final newline.

| Local file in `public/assets/providers/` | Pinned source |
| --- | --- |
| `github.svg` | [GitHub](https://raw.githubusercontent.com/simple-icons/simple-icons/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/icons/github.svg) |
| `vercel.svg` | [Vercel](https://raw.githubusercontent.com/simple-icons/simple-icons/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/icons/vercel.svg) |
| `railway.svg` | [Railway](https://raw.githubusercontent.com/simple-icons/simple-icons/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/icons/railway.svg) |
| `stripe.svg` | [Stripe](https://raw.githubusercontent.com/simple-icons/simple-icons/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/icons/stripe.svg) |
| `supabase.svg` | [Supabase](https://raw.githubusercontent.com/simple-icons/simple-icons/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/icons/supabase.svg) |
| `langgraph.svg` | [LangGraph](https://raw.githubusercontent.com/simple-icons/simple-icons/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/icons/langgraph.svg) |
| `nextdotjs.svg` | [Next.js](https://raw.githubusercontent.com/simple-icons/simple-icons/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/icons/nextdotjs.svg) |
| `hono.svg` | [Hono](https://raw.githubusercontent.com/simple-icons/simple-icons/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/icons/hono.svg) |
| `openrouter.svg` | [OpenRouter](https://raw.githubusercontent.com/simple-icons/simple-icons/b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76/icons/openrouter.svg) |

Brand colors of the four recolored marks:

| Mark | Fill | Brand source recorded by the pinned metadata |
| --- | --- | --- |
| Stripe | `#635BFF` | [Official Stripe newsroom](https://stripe.com/newsroom/information) |
| Supabase | `#3FCF8E` | [Official Supabase artwork](https://github.com/supabase/supabase/blob/4031a7549f5d46da7bc79c01d56be4177dc7c114/packages/common/assets/images/supabase-logo-wordmark--light.svg) |
| Hono | `#E36002` | [Official Hono artwork](https://github.com/honojs/hono/blob/76dbc74407329c46870af6aa4fab0c04036d8ae2/docs/images/hono-logo.svg) |
| LangGraph | `#7FC8FF` | [Official LangGraph site](https://www.langchain.com/langgraph) |

These are the single-color Simple Icons marks in their documented brand colors, not newly drawn geometry. The pinned LangGraph revision uses the newer light-blue mark. Trigger.dev's `#41FF54` → `#E7FF52` gradient is unchanged. GitHub, Vercel, Railway, Next.js, OpenRouter and the Composio artwork keep their monochrome source colors.

Simple Icons distributes its work under CC0 1.0 Universal. The complete notice is in `public/assets/licenses/Simple-Icons-LICENSE.md`; it expressly preserves trademark rights.

Two logos absent from that Simple Icons revision come directly from their providers:

| Local file | Official source and transformation | Repository license |
| --- | --- | --- |
| `composio.svg` | [Composio Logo.svg](https://raw.githubusercontent.com/ComposioHQ/composio/cd9ee743abdb12b682dde60415a1eecba505fee0/docs/public/Composio%20Logo.svg), commit `cd9ee743abdb12b682dde60415a1eecba505fee0`. The complete original mark group and its clip definition, with the viewBox fitted to the original clip dimensions. All mark paths and strokes are unchanged. The wordmark is omitted for compact integration cards. | MIT, copyright 2025 Sampark Inc.; full notice in `public/assets/licenses/Composio-LICENSE.txt`. |
| `triggerdotdev.svg` | [Trigger.dev LogoIcon.tsx](https://raw.githubusercontent.com/triggerdotdev/trigger.dev/9d7a60bc144d3ac03820bfe6b01cd4ba37349db1/apps/webapp/app/components/LogoIcon.tsx), commit `9d7a60bc144d3ac03820bfe6b01cd4ba37349db1`. The official component converted to standalone SVG, keeping its exact path, viewBox and gradient. JSX attribute spelling (`fillRule`, `clipRule`, `stopColor`) became standard SVG spelling, and the React-only class expression was removed. | Apache 2.0; full notice in `public/assets/licenses/Trigger-LICENSE.txt`. |

Source URLs, transformations, file sizes and SHA-256 digests are also recorded in `public/assets/providers/provenance.json`. The four recolored marks also keep the original download's size and digest as `sourceBytes` and `sourceSha256`; `bytes` and `sha256` identify the local files.

`service.svg` is the Lucide **Box** icon, a generic service fallback, never a fabricated provider brand.

On dark surfaces the interface applies `filter: invert(1)` only to marks with `data-monochrome="true"`, which keeps their internal black and white contrast, including Composio's artwork. Stripe, Supabase, Hono, LangGraph and Trigger.dev have `data-monochrome="false"` and keep their source colors in both themes. The OpenRouter mark in Settings inverts in the dark theme.

## Interface icons

The interface imports icons from the `lucide-react` package; no icon geometry is redrawn. [Lucide](https://github.com/lucide-icons/lucide) is ISC, with some Feather-derived portions under MIT. Both notices are in `public/assets/licenses/Lucide-LICENSE.txt`.

## Fonts

| Local font | Font |
| --- | --- |
| `public/assets/fonts/geist-sans.woff2` | Geist, Latin subset, variable weights 100–900, normal style |
| `public/assets/fonts/geist-mono.woff2` | Geist Mono, Latin subset, variable weights 100–900, normal style |

Other scripts use system fallbacks. Upstream: [Geist Font](https://github.com/vercel/geist-font). License: SIL Open Font License 1.1, copyright 2024 The Geist Project Authors; the license is in `public/assets/licenses/Geist-OFL.txt`.

## Registry components

The React interface in `client/` uses components from the official shadcn registries:

- [shadcn Table](https://ui.shadcn.com/docs/components/table): `client/src/components/ui/table.tsx` is the unchanged `table` component from the [official new-york-v4 registry](https://ui.shadcn.com/r/styles/new-york-v4/table.json), downloaded on 2026-10-06. Its responsive wrapper and semantic table primitives compose the Pipelines table. It shares the shadcn MIT notice below.

- [shadcn Breadcrumb](https://ui.shadcn.com/docs/components/breadcrumb): `client/src/components/ui/breadcrumb.tsx` is the unchanged `breadcrumb` component from the [official new-york-v4 registry](https://ui.shadcn.com/r/styles/new-york-v4/breadcrumb.json), downloaded on 2026-10-06. It presents the current page and its navigable parent in the workspace header, with the shadcn MIT notice below.

- [shadcn/ui](https://ui.shadcn.com/): Alert, Alert Dialog, Badge, Button, Card, Checkbox, Collapsible, Dialog, Dropdown Menu, Input, Item, Label, Select, Separator, Sheet, Sidebar, Skeleton, Spinner, Switch, Tabs, Textarea and Tooltip in `client/src/components/ui/`, and Sidebar's mobile hook in `client/src/hooks/use-mobile.ts`. Item was installed from the official new-york-v4 registry with `npx shadcn add item --yes`, and Spinner with `npx shadcn add spinner --yes`; its one local adaptation puts the spin under `motion-safe:`, so it stops with reduced motion like every other spinner here. shadcn/ui is MIT, copyright 2023 shadcn; the notice, from [`LICENSE.md`](https://github.com/shadcn-ui/ui/blob/6ea6856f5a1082d4d9c231559b6bc3ee73827493/LICENSE.md) in `shadcn-ui/ui`, is in `public/assets/licenses/shadcn-ui-LICENSE.txt`.
- [React Flow UI Base Node](https://reactflow.dev/ui/components/base-node): `client/src/components/base-node.tsx`, installed from `https://ui.reactflow.dev/base-node`. MIT, copyright webkid GmbH; the notice is in `public/assets/licenses/React-Flow-LICENSE.txt`. The graph runtime is `@xyflow/react`. The paid React Flow Workflow Editor template is not included.
- [jal-co/ui Commit Graph](https://ui.justinlevine.me/docs/components/commit-graph): `client/src/components/commit-graph.tsx`, installed with the shadcn CLI from a reviewed copy of `https://ui.justinlevine.me/r/commit-graph.json`. This is a community registry component, not an official shadcn primitive. Its MIT notice is in `public/assets/licenses/jal-co-ui-LICENSE.txt`. Local adaptations move inline rail badge and tag colors and fixed row sizing to CSS classes for the existing Content Security Policy, remove the sample-data linear-parent inference so real roots stay roots, and condense long ref lists while keeping every ref in the scrollable commit popover. The registry's rail layout computation and SVG rendering are kept, except that a merge whose second parent already has a rail is drawn from the merge down to that rail, as a first parent is, instead of from the commit above on that rail. Its drawer is the same shadcn Sheet as the pipeline settings.
- [Magic UI Border Beam](https://magicui.design/docs/components/border-beam): `client/src/components/ui/border-beam.tsx`, installed with `npx shadcn add @magicui/border-beam --yes` from the CLI's built-in `@magicui` registry, for a stage card's in-flight animation. This is a community registry component, not an official shadcn primitive. It moves a `motion` element along the card's border with CSS `offset-path`; `motion` sets its styles through the CSSOM, which the Content Security Policy's `style-src-attr 'none'` does not block. MIT, copyright Magic UI; the notice is in `public/assets/licenses/magicui-LICENSE.txt`.

Navigation uses the Sidebar composition with `defaultOpen={false}`. The configuration panel composes Sheet, Tabs, Card and form components with their registry appearance; the application layout sets the panel width and scrolling. Theme tokens keep the application's neutral palette.

`client/src/StepList.tsx` composes ItemGroup, Item, ItemMedia, ItemContent and a vertical Separator for the continuous rail and circular marks used by stage providers, tests and nested GitHub workflows, jobs and steps. The rail geometry is application composition, not an official Timeline component; Collapsible keeps the expansion behaviour.

Exact dependency versions are recorded in `package-lock.json`, and the libraries' own license notices stay in their installed packages.

## Checks

Every local SVG parses as XML and contains no script, external image or remote reference.
