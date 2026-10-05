import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Render the real Git graph without a dev server or a browser; its stylesheet is left out.
const client = new URL('../client/src/', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.css') && context.parentURL?.startsWith(client.href)) return { url: 'data:text/javascript,', shortCircuit: true };
    const candidate = specifier.startsWith('@/') ? new URL(specifier.slice(2), client)
      : specifier.startsWith('.') && context.parentURL?.startsWith(client.href) ? new URL(specifier, context.parentURL) : null;
    if (candidate) for (const suffix of ['', '.ts', '.tsx']) {
      const path = fileURLToPath(candidate) + suffix;
      if (existsSync(path)) return next(pathToFileURL(path).href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(client.href) && url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: transformSync(fileURLToPath(url), readFileSync(new URL(url), 'utf8'), { jsx: { runtime: 'automatic' } }).code };
    return next(url, context);
  },
});
const { CommitGraph } = await import(new URL('../client/src/components/commit-graph.tsx', import.meta.url).href);

type Point = { x: number; y: number };
type Stroke = { top: Point; bottom: Point };
type DrawnRow = { height: number; dot: Point; strokes: Stroke[] };
const number = (tag: string, name: string) => Number(tag.match(new RegExp(`\\s${name}="([^"]*)"`))![1]);
const stroke = (a: Point, b: Point): Stroke => a.y <= b.y ? { top: a, bottom: b } : { top: b, bottom: a };

// Each row's dot and every line and curve it draws, by the two ends of each.
function drawnRows(markup: string): DrawnRow[] {
  return [...markup.matchAll(/<svg\b[^>]*>.*?<\/svg>/gs)].map(([svg]) => {
    const circle = svg.match(/<circle\b[^>]*>/)![0];
    const strokes = [...svg.matchAll(/<line\b[^>]*>/g)].map(([line]) => stroke({ x: number(line, 'x1'), y: number(line, 'y1') }, { x: number(line, 'x2'), y: number(line, 'y2') }));
    for (const [path] of svg.matchAll(/<path\b[^>]*>/g)) {
      const values = path.match(/\sd="([^"]*)"/)![1].match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      assert.equal(values.length, 8, 'One cubic curve per path.');
      strokes.push(stroke({ x: values[0], y: values[1] }, { x: values[6], y: values[7] }));
    }
    return { height: number(svg.match(/<svg\b[^>]*>/)![0], 'height'), dot: { x: number(circle, 'cx'), y: number(circle, 'cy') }, strokes };
  });
}

// A link from one commit down to another is drawn when a continuous stroke leaves the upper dot, runs down through
// the rows between them and arrives at the lower dot.
function drawnLinks(rows: DrawnRow[], labels: string[]) {
  const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y, links = new Set<string>();
  rows.forEach((row, from) => {
    let columns = new Set(row.strokes.filter(item => same(item.top, row.dot) && item.bottom.y === row.height).map(item => item.bottom.x));
    for (let to = from + 1; to < rows.length && columns.size; to++) {
      const below = rows[to], next = new Set<number>();
      for (const item of below.strokes) {
        if (item.top.y !== 0 || !columns.has(item.top.x)) continue;
        if (same(item.bottom, below.dot)) links.add(`${labels[from]} -> ${labels[to]}`);
        else if (item.bottom.y === below.height) next.add(item.bottom.x);
      }
      columns = next;
    }
  });
  return [...links].sort();
}

// Commits newest first in `git log --topo-order`, each with its parents by label, as GitGraphPanel passes them.
function graph(history: [label: string, ...parents: string[]][]) {
  const hash = (label: string) => label.toLowerCase().padEnd(40, '0');
  const commits = history.map(([label, ...parents]) => ({ hash: hash(label), message: label, author: { name: 'Example author' }, date: '2026-01-01T00:00:00Z', parents: parents.map(hash) }));
  const rows = drawnRows(renderToStaticMarkup(createElement(CommitGraph, { commits, railWidth: 20, className: 'git-history-graph' })));
  assert.equal(rows.length, history.length, 'One drawn row per commit.');
  const parentLinks = history.flatMap(([label, ...parents]) => parents.map(parent => `${label} -> ${parent}`)).sort();
  return { drawn: drawnLinks(rows, history.map(([label]) => label)), parentLinks };
}

test('a plain merge draws exactly its parent links', () => {
  const { drawn, parentLinks } = graph([['M', 'B', 'F'], ['F', 'A'], ['B', 'A'], ['A']]);
  assert.deepEqual(drawn, parentLinks);
});

test('a merge whose second parent already has a rail draws its link down to that parent', () => {
  // The branch was updated from main (F2 = merge of F1 and B), then its pull request merged (M = merge of B and F2).
  const { drawn, parentLinks } = graph([['M', 'B', 'F2'], ['F2', 'F1', 'B'], ['B', 'A'], ['F1', 'A'], ['A']]);
  assert.deepEqual(drawn, parentLinks);
});

test('a branch that goes on after its merge is never linked to the merge', () => {
  // All branches: G continues the merged branch F after M = merge of C and F.
  const { drawn, parentLinks } = graph([['G', 'F'], ['M', 'C', 'F'], ['F', 'A'], ['C', 'A'], ['A']]);
  assert.deepEqual(drawn, parentLinks);
});
