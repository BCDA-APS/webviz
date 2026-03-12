/**
 * Production server — serves the Vite build (dist/) and proxies
 * /tiled-proxy/, /qs-proxy/, and /qs-stream/ to their backends.
 *
 * Usage:
 *   npm run build
 *   node server.mjs           # listens on PORT env var, default 4173
 */

import express from 'express';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '4173');

const app = express();

/** Parse a proxy URL of the form /<protocol>/<host:port>/... */
function parseProxyTarget(url) {
  const match = (url ?? '/').match(/^\/?([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const protocol = match[1];
  const host = match[2];
  const path = match[3] ?? '/';
  const [hostname, portStr] = host.split(':');
  const port = portStr ? parseInt(portStr) : (protocol === 'https' ? 443 : 80);
  const transport = protocol === 'https' ? https : http;
  return { protocol, host, hostname, port, path, transport };
}

// ── Tiled proxy ──────────────────────────────────────────────────────────────
// Routes: /tiled-proxy/<protocol>/<host:port>/...
app.use('/tiled-proxy', (req, res) => {
  const target = parseProxyTarget(req.url);
  if (!target) {
    res.status(400).send('Bad proxy URL — expected /tiled-proxy/<protocol>/<host:port>/...');
    return;
  }

  const { protocol, host, hostname, port, transport } = target;

  // Strip sort param — some Tiled trees don't support it
  const [pathOnly, rawQuery] = target.path.split('?');
  const params = new URLSearchParams(rawQuery ?? '');
  params.delete('sort');
  const queryStr = params.toString();
  const path = queryStr ? `${pathOnly}?${queryStr}` : pathOnly;

  const proxyReqHeaders = { ...req.headers, host };
  delete proxyReqHeaders['accept-encoding']; // get uncompressed so we can rewrite JSON

  const proxyReq = transport.request(
    { hostname, port, path, method: req.method, headers: proxyReqHeaders },
    (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] ?? '';

      if (!contentType.includes('application/json')) {
        // Non-JSON: stream directly without buffering
        const headers = { ...proxyRes.headers, 'access-control-allow-origin': '*' };
        res.writeHead(proxyRes.statusCode ?? 200, headers);
        proxyRes.pipe(res);
        return;
      }

      // JSON: buffer so we can rewrite absolute server URLs
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const origin = `http://${req.headers.host}`;
        let text = Buffer.concat(chunks).toString('utf-8');
        text = text.replaceAll(
          `${protocol}://${host}`,
          `${origin}/tiled-proxy/${protocol}/${host}`
        );
        const body = Buffer.from(text);
        const headers = { ...proxyRes.headers };
        headers['content-length'] = String(body.length);
        headers['access-control-allow-origin'] = '*';
        delete headers['content-encoding'];
        res.writeHead(proxyRes.statusCode ?? 200, headers);
        res.end(body);
      });
    }
  );

  proxyReq.on('error', (err) => {
    res.status(502).send(`Proxy error: ${err.message}`);
  });

  req.pipe(proxyReq);
});

// ── QServer HTTP proxy ────────────────────────────────────────────────────────
// Routes: /qs-proxy/<protocol>/<host:port>/...
app.use('/qs-proxy', (req, res) => {
  const target = parseProxyTarget(req.url);
  if (!target) {
    res.status(400).send('Bad proxy URL — expected /qs-proxy/<protocol>/<host:port>/...');
    return;
  }

  const { host, hostname, port, path, transport } = target;
  const proxyReqHeaders = { ...req.headers, host };
  delete proxyReqHeaders['accept-encoding'];

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const proxyReq = transport.request(
      { hostname, port, path, method: req.method, headers: { ...proxyReqHeaders, 'content-length': body.length } },
      (proxyRes) => {
        const headers = { ...proxyRes.headers };
        headers['access-control-allow-origin'] = '*';
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        delete headers['content-length'];
        res.writeHead(proxyRes.statusCode ?? 200, headers);
        res.flushHeaders();
        res.socket?.setNoDelay(true);
        proxyRes.on('data', (chunk) => res.write(chunk));
        proxyRes.on('end', () => res.end());
        proxyRes.on('error', (err) => res.destroy(err));
        req.on('close', () => proxyReq.destroy());
      }
    );
    proxyReq.on('error', (err) => { res.status(502).send(`Proxy error: ${err.message}`); });
    proxyReq.end(body);
  });
});

// ── QServer SSE proxy ─────────────────────────────────────────────────────────
// Routes: /qs-stream/<protocol>/<host:port>/...
app.use('/qs-stream', (req, res) => {
  const target = parseProxyTarget(req.url);
  if (!target) {
    res.status(400).send('Bad URL — expected /qs-stream/<protocol>/<host:port>/...');
    return;
  }

  const { host, hostname, port, path: rawPath, transport } = target;
  const [pathOnly, queryStr] = rawPath.split('?');
  const params = new URLSearchParams(queryStr ?? '');
  const apiKey = params.get('api_key') ?? '';

  const upstreamHeaders = { host };
  if (apiKey) upstreamHeaders['Authorization'] = `ApiKey ${apiKey}`;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  res.write(': connected\n\n');

  const proxyReq = transport.request(
    { hostname, port, path: pathOnly, method: 'GET', headers: upstreamHeaders },
    (proxyRes) => {
      let buf = '';
      proxyRes.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          if (part.trim()) res.write(`data: ${part.trim()}\n\n`);
        }
        const trimmed = buf.trim();
        if (trimmed.startsWith('{')) {
          try { JSON.parse(trimmed); res.write(`data: ${trimmed}\n\n`); buf = ''; } catch { /* incomplete */ }
        }
      });
      proxyRes.on('end', () => res.end());
      proxyRes.on('error', () => res.end());
    }
  );
  proxyReq.on('error', (err) => { console.error('[qs-stream] error:', err.message); res.end(); });
  req.on('close', () => proxyReq.destroy());
  proxyReq.end();
});

// ── Static files (Vite build output) ─────────────────────────────────────────
app.use(express.static(join(__dirname, 'dist')));

// SPA fallback — serve index.html for all unmatched routes so React Router works
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

http.createServer(app).listen(PORT, () => {
  console.log(`webviz running at http://localhost:${PORT}`);
});
