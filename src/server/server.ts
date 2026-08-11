import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiContext, handleApiRequest } from './api.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 2MB is far above any legitimate tag payload and well below a memory problem. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface ServerOptions extends ApiContext {
  port: number;
  host: string;
  publicDir?: string;
}

function defaultPublicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'public');
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) return resolvePromise(null);
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function serveStatic(res: ServerResponse, publicDir: string, urlPath: string): void {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

  // Resolve then confirm containment: blocks ../ traversal out of publicDir.
  const target = resolve(publicDir, normalize(relative));
  const root = resolve(publicDir);
  if (target !== root && !target.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(target).pipe(res);
}

export function createDashboardServer(options: ServerOptions) {
  const publicDir = options.publicDir ?? defaultPublicDir();

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    try {
      if (url.pathname.startsWith('/api/')) {
        const body = method === 'POST' ? await readBody(req) : null;
        const result = await handleApiRequest(method, url.pathname, url.searchParams, body, options);
        sendJson(res, result.status, result.body);
        return;
      }

      if (method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      serveStatic(res, publicDir, url.pathname);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  });
}

export function startDashboardServer(options: ServerOptions): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createDashboardServer(options);

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      // Report the port actually bound, not the one asked for: port 0 means
      // "any free port", and echoing the request back yields a dead URL.
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      const shown = options.host === '0.0.0.0' ? 'localhost' : options.host;
      resolvePromise({
        url: `http://${shown}:${port}`,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}
