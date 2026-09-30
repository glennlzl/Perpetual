import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { sendVideo } from '../src/browser/video-file.ts';

test('recorded browser tabs remain playable and recover from unavailable media', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-recording-ui-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = createHttpServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><title>Recording transport check</title></head><body><h1>Recording transport check</h1><button onclick="document.querySelector(\'section\').hidden=false">Open details</button><section hidden>Details opened</section></body></html>');
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => target.close(() => resolve())));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const recorder = await browser.newContext({ viewport: { width: 640, height: 400 }, recordVideo: { dir, size: { width: 640, height: 400 } } });
  const videos: string[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const page = await recorder.newPage();
      await page.goto(`http://127.0.0.1:${(target.address() as AddressInfo).port}/?tab=${index + 1}`);
      await page.getByRole('button', { name: 'Open details' }).click();
      await expect(page.getByText('Details opened', { exact: true })).toBeVisible();
      videos.push(await page.video()!.path());
    }
    // Keep the last observed frame on screen long enough for the real recorder to capture it.
    await new Promise(resolve => setTimeout(resolve, 800));
  } finally { await recorder.close(); }
  let recover = false;
  const urls = [...videos.map((_, index) => `/build/__media/${index}.webm`), '/build/__media/unavailable.webm'];
  const entry = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import JourneyRecording from '/src/JourneyRecording.tsx';
    import '/src/index.css';
    import '/src/workspace.css';
    createRoot(document.getElementById('root')).render(React.createElement('div',{className:'pipeline-inspector'},React.createElement(JourneyRecording,{urls:${JSON.stringify(urls)},name:'Recorded journey'})));
  `;
  const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'recording-ui-test',
    resolveId(id) { if (id.endsWith('/__recording-ui.tsx')) return '\0recording-ui'; },
    load(id) { if (id === '\0recording-ui') return entry; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
        if (path.startsWith('/build/__media/')) {
          const name = path.split('/').at(-1), index = name === 'unavailable.webm' ? 0 : Number(name?.replace('.webm', ''));
          if (name === 'unavailable.webm' && !recover) { res.statusCode = 503; res.end('Recording unavailable'); return; }
          const video = videos[index];
          if (!video) { res.statusCode = 404; res.end(); return; }
          await sendVideo(req, res, { path: video, size: (await stat(video)).size }); return;
        }
        if (/^\/assets\/fonts\/geist-(sans|mono)\.woff2$/.test(path)) {
          res.setHeader('Content-Type', 'font/woff2'); res.end(await readFile(new URL(`../public${path}`, import.meta.url))); return;
        }
        if (path === '/build/__recording-ui') {
          res.setHeader('Content-Type', 'text/html');
          res.end(await server.transformIndexHtml('/__recording-ui', '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recording UI test</title></head><body><div id="root"></div><script type="module" src="/build/__recording-ui.tsx"></script></body></html>')); return;
        }
        next();
      });
    },
  }] });
  await server.listen(); t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__recording-ui`;
  await t.test('real recorded frames play and pause through the native controls', async t => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } }); t.after(() => page.close());
    await page.goto(url);
    const video = page.getByLabel('Recorded journey recording', { exact: true });
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(2);
    await video.press('Space');
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0);
    await video.press('Space');
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
    assert.ok(await video.evaluate((el: HTMLVideoElement) => el.videoWidth > 0 && el.duration > 0));
  });
  await t.test('all recording tabs remain reachable at a narrow width', async t => {
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } }); t.after(() => page.close());
    await page.goto(url);
    await page.getByRole('tab', { name: 'Tab 1', exact: true }).press('End');
    await expect(page.getByRole('tab', { name: 'Tab 9', exact: true })).toBeInViewport();
    await page.getByRole('tab', { name: 'Tab 9', exact: true }).press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'Tab 8', exact: true })).toBeInViewport();
    await expect(page.getByLabel('Recorded journey recording', { exact: true })).toBeInViewport({ ratio: 1 });
  });
  await t.test('a failed recording offers a retry that loads recovered media', async t => {
    const page = await browser.newPage({ viewport: { width: 320, height: 800 }, hasTouch: true }); t.after(() => page.close());
    await page.goto(url);
    await page.getByRole('tab', { name: 'Tab 9', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Recording unavailable.');
    await expect(page.getByRole('button', { name: 'Retry recording', exact: true })).toBeInViewport({ ratio: 1 });
    const tabs = await page.getByRole('tablist').boundingBox(), error = await page.getByRole('alert').boundingBox();
    assert.ok(tabs && error && error.y >= tabs.y + tabs.height, `The recording tabs must not cover the error: ${JSON.stringify({tabs, error})}`);
    await page.getByRole('button', { name: 'Retry recording', exact: true }).tap();
    await expect(page.getByRole('alert')).toHaveText('Recording unavailable.');
    await expect(page.getByRole('button', { name: 'Retry recording', exact: true })).toBeFocused();
    await page.getByRole('tab', { name: 'Tab 1', exact: true }).press('Home');
    await expect.poll(() => page.getByLabel('Recorded journey recording', { exact: true }).evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Tab 1', exact: true }).press('End');
    await expect(page.getByRole('alert')).toHaveText('Recording unavailable.');
    recover = true;
    await page.getByRole('button', { name: 'Retry recording', exact: true }).click();
    await expect.poll(() => page.getByLabel('Recorded journey recording', { exact: true }).evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Tab 9', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Recorded journey recording', { exact: true })).toBeFocused();
  });
});
