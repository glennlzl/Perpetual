import { createServer, type IncomingMessage } from 'node:http';

async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024) throw new Error('Invalid request.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** Deliberately loopback-only. This server cannot be exposed by changing a host environment variable. */
export async function listenTrial(handle: (request: Request) => Promise<Response>, port = 43179) {
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 5000 }, async (req, res) => {
    try {
      const address = server.address();
      if (!address || typeof address === 'string' || req.headers.host !== `127.0.0.1:${address.port}` || !req.url?.startsWith('/') || req.url.startsWith('//')) {
        res.writeHead(403, { 'Cache-Control': 'no-store' }).end(); return;
      }
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
        res.writeHead(403, { 'Cache-Control': 'no-store' }).end(); return;
      }
      const body = await bodyOf(req);
      if (body.length && req.method === 'GET') { res.writeHead(400).end(); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      const request = new Request(`http://127.0.0.1:${address.port}${req.url}`, { method: req.method, headers, ...(body.length ? { body } : {}) });
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(400, { 'Cache-Control': 'no-store' }).end(); }
  });
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}
