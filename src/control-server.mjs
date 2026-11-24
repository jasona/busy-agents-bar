import { createServer } from 'node:http';

const MAX_BODY_BYTES = 256 * 1024;

function jsonReply(res, status, payload, closeSocket = false) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (closeSocket) headers.Connection = 'close';
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload), () => {
    if (closeSocket) res.socket?.destroy();
  });
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        settled = true;
        req.pause();
        rejectBody(
          Object.assign(new Error('Request body exceeds 256KB limit'), {
            status: 413,
            code: 'PAYLOAD_TOO_LARGE',
          })
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolveBody({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return rejectBody(
            Object.assign(new Error('JSON body must be an object'), {
              status: 400,
              code: 'INVALID_JSON',
            })
          );
        }
        resolveBody(parsed);
      } catch {
        rejectBody(
          Object.assign(new Error('Malformed JSON request body'), {
            status: 400,
            code: 'INVALID_JSON',
          })
        );
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      rejectBody(
        Object.assign(new Error(err?.message || 'Request stream error'), {
          status: 400,
          code: 'READ_ERROR',
        })
      );
    });
  });
}

function normalizeAlertPatch(body) {
  const patch = {};
  if (typeof body.blink === 'boolean') {
    patch.blink = { enabled: body.blink };
  } else if (body.blink && typeof body.blink === 'object') {
    patch.blink = body.blink;
  }

  if (typeof body.chime === 'boolean') {
    patch.chime = { enabled: body.chime };
  } else if (body.chime && typeof body.chime === 'object') {
    patch.chime = body.chime;
  }

  return patch;
}

async function parseJsonRequest(req, res) {
  try {
    return await readJsonBody(req);
  } catch (err) {
    jsonReply(
      res,
      err.status || 400,
      { ok: false, error: err.message, code: err.code || 'INVALID_BODY' },
      err.status === 413
    );
    return null;
  }
}

/**
 * Creates the loopback HTTP control & webhook server for the BUSY Bar daemon.
 */
export function createControlServer({ daemon, hookProvider, host = '127.0.0.1', port = 4388 }) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${host}`);
      const pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      if (pathname === '/health') {
        if (method !== 'GET') return jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        const st = daemon.getStatus();
        return jsonReply(res, 200, {
          ok: true,
          connected: st.connected,
          phase: st.snapshot?.phase || 'cleared',
          uptimeSec: st.uptimeSec,
        });
      }

      if (pathname === '/status') {
        if (method !== 'GET') return jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        return jsonReply(res, 200, { ok: true, ...daemon.getStatus() });
      }

      if (pathname === '/clear') {
        if (method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        const result = await daemon.clear();
        return jsonReply(res, 200, { ok: true, ...result });
      }

      if (pathname === '/reset') {
        if (method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        const result = await daemon.reset({ reason: 'api', onlyIfVisible: false });
        return jsonReply(res, 200, { ok: true, ...result });
      }

      if (pathname === '/dismiss') {
        if (method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        const body = await parseJsonRequest(req, res);
        if (!body) return;
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (!sessionId) {
          return jsonReply(res, 400, { ok: false, error: 'sessionId is required', code: 'MISSING_SESSION_ID' });
        }
        const result = await daemon.dismissSession({
          provider: typeof body.provider === 'string' ? body.provider.trim() : 'antigravity',
          sessionId,
          atMs: body.atMs,
        });
        return jsonReply(res, 200, { ok: true, ...result });
      }

      if (pathname === '/alerts') {
        if (method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        const body = await parseJsonRequest(req, res);
        if (!body) return;
        const patch = normalizeAlertPatch(body);
        const alerts = await daemon.updateAlerts(patch);
        return jsonReply(res, 200, { ok: true, alerts, snapshot: daemon.getStatus().snapshot });
      }

      const hookMatch = pathname.match(/^\/hooks\/([a-zA-Z0-9._-]+)(?:\/([^/]+))?$/);
      if (hookMatch) {
        const providerName = decodeURIComponent(hookMatch[1]);
        const sessionId = hookMatch[2] ? decodeURIComponent(hookMatch[2]) : '';

        if (!hookProvider) {
          return jsonReply(res, 503, { ok: false, error: 'Hook provider is disabled' });
        }

        if (!sessionId) {
          if (method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
          const body = await parseJsonRequest(req, res);
          if (!body) return;
          try {
            const now = typeof daemon._now === 'function' ? daemon._now() : Date.now();
            const session = hookProvider.ingest(providerName, body, now);
            const snapshot = await daemon.sync();
            return jsonReply(res, 200, { ok: true, session, ignored: !session, snapshot });
          } catch (err) {
            return jsonReply(res, 400, { ok: false, error: err?.message || 'Invalid hook payload' });
          }
        }

        if (method !== 'DELETE') return jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        const removed = hookProvider.remove(providerName, sessionId);
        const snapshot = await daemon.sync();
        return jsonReply(res, 200, { ok: true, removed, snapshot });
      }

      return jsonReply(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      return jsonReply(res, 500, { ok: false, error: err?.message || 'Internal server error' });
    }
  });

  let actualPort = port;

  return {
    server,
    get port() {
      return actualPort;
    },
    get url() {
      return `http://${host}:${actualPort}`;
    },
    start() {
      return new Promise((resolveStart, rejectStart) => {
        server.once('error', rejectStart);
        server.listen(port, host, () => {
          server.off('error', rejectStart);
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            actualPort = addr.port;
          }
          resolveStart({ host, port: actualPort, url: `http://${host}:${actualPort}` });
        });
      });
    },
    stop() {
      return new Promise((resolveStop, rejectStop) => {
        if (!server.listening) return resolveStop();
        server.close((err) => (err ? rejectStop(err) : resolveStop()));
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
    },
  };
}
