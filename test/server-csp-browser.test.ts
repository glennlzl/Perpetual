import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { startServer, type Controller } from '../src/server.ts';

test('preview annotation styles can change while inline scripts and handlers remain blocked', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-csp-browser-'));
  let app: Controller | undefined, browser: Browser | undefined;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
  });
  const publicDir = join(dir, 'public');
  await mkdir(join(publicDir, 'build'), { recursive: true });
  await writeFile(join(publicDir, 'build/index.html'), '<!doctype html><html><head></head><body><button id="target">Annotate</button></body></html>');
  app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'data'), publicDir });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const styleErrors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('style-src')) styleErrors.push(message.text());
  });
  await page.goto(app.url);

  // Preview tools insert CSS without the application's nonce and change it between versions.
  for (const color of ['rgb(17, 34, 51)', 'rgb(51, 34, 17)']) {
    const actual = await page.evaluate(color => {
      const style = document.querySelector<HTMLStyleElement>('#annotation-style') ?? document.createElement('style');
      style.id = 'annotation-style';
      style.textContent = `#target { outline: 3px solid ${color}; }`;
      document.head.append(style);
      return getComputedStyle(document.querySelector('#target')!).outlineColor;
    }, color);
    assert.equal(actual, color, `A preview stylesheet without the page nonce must apply: ${styleErrors.join('\n')}`);
  }
  assert.deepEqual(styleErrors, []);

  const scriptRan = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'document.body.dataset.inlineScriptRan = "yes"';
    document.head.append(script);
    return document.body.dataset.inlineScriptRan;
  });
  assert.equal(scriptRan, undefined, 'Inline JavaScript must remain blocked');

  const handlerRan = await page.evaluate(() => {
    const target = document.querySelector<HTMLButtonElement>('#target')!;
    target.setAttribute('onclick', 'document.body.dataset.inlineHandlerRan = "yes"');
    target.click();
    return document.body.dataset.inlineHandlerRan;
  });
  assert.equal(handlerRan, undefined, 'Inline event handlers must remain blocked');

  const background = await page.evaluate(() => {
    const target = document.querySelector<HTMLButtonElement>('#target')!;
    target.setAttribute('style', 'background-color: rgb(17, 34, 51)');
    return getComputedStyle(target).backgroundColor;
  });
  assert.notEqual(background, 'rgb(17, 34, 51)', 'Style attributes must remain blocked');
});
