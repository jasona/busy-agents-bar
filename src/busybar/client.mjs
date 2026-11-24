import http from 'node:http';
import https from 'node:https';

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Lightweight HTTP client for the BUSY Bar local API (OpenAPI 24.3.0).
 * Uses node:http/https directly because the BUSY Bar's embedded HTTP server triggers
 * undici's strict ResponseContentLengthMismatchError on socket close under global fetch().
 */
export class BusyBarClient {
  constructor(config = {}) {
    const dev = config.device || config;
    this.baseUrl = String(dev.baseUrl || 'http://10.0.4.20').replace(/\/+$/, '');
    this.apiToken = dev.apiToken ? String(dev.apiToken).trim() || null : null;
    this.applicationName = String(dev.applicationName || 'agent-status');
    this.timeoutMs = Math.max(500, Number(dev.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  }

  _request(method, path, { jsonBody = undefined, binary = false } = {}) {
    const targetUrl = new URL(`${this.baseUrl}${path}`);
    const transport = targetUrl.protocol === 'https:' ? https : http;
    const headers = {
      Connection: 'close',
    };
    if (this.apiToken) {
      if (targetUrl.hostname === 'api.busy.app') {
        headers.Authorization = `Bearer ${this.apiToken}`;
      } else {
        headers['X-API-Token'] = this.apiToken;
      }
    }
    let payloadStr = null;
    if (jsonBody !== undefined) {
      payloadStr = JSON.stringify(jsonBody);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payloadStr);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        fn(val);
      };

      const req = transport.request(
        targetUrl,
        {
          method,
          headers,
          agent: false,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const rawBuffer = Buffer.concat(chunks);
            const status = res.statusCode || 0;
            const ok = status >= 200 && status < 300;
            if (binary) {
              return done(resolve, { status, ok, body: rawBuffer });
            }

            const contentType = String(res.headers['content-type'] || '');
            const text = rawBuffer.toString('utf-8').trim();
            let parsedBody = null;
            if (text && (contentType.includes('application/json') || text.startsWith('{') || text.startsWith('['))) {
              try {
                parsedBody = JSON.parse(text);
              } catch {
                parsedBody = text;
              }
            } else if (text) {
              parsedBody = text;
            }
            done(resolve, { status, ok, body: parsedBody });
          });
          res.on('error', (err) => done(reject, err));
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Request timed out after ${this.timeoutMs}ms`));
      });
      req.on('error', (err) => done(reject, err));

      if (payloadStr !== null) {
        req.write(payloadStr);
      }
      req.end();
    });
  }

  async getStatus() {
    const { ok, status, body } = await this._request('GET', '/api/status');
    if (!ok) {
      throw new Error(`GET /api/status failed (${status})`);
    }
    return body;
  }

  async getVersion() {
    const { ok, status, body } = await this._request('GET', '/api/version');
    if (!ok) {
      throw new Error(`GET /api/version failed (${status})`);
    }
    return body;
  }

  async getTime() {
    const { ok, status, body } = await this._request('GET', '/api/time');
    if (!ok) {
      throw new Error(`GET /api/time failed (${status})`);
    }
    return body;
  }

  async draw(payload) {
    const { ok, status, body } = await this._request('POST', '/api/display/draw', {
      jsonBody: payload,
    });
    return {
      ok,
      status,
      preempted: status === 409,
      body,
    };
  }

  async clearDisplay(applicationName = this.applicationName) {
    const query = applicationName
      ? `?application_name=${encodeURIComponent(applicationName)}`
      : '';
    const { ok, status, body } = await this._request('DELETE', `/api/display/draw${query}`);
    return { ok, status, body };
  }

  async playAudio({ applicationName = this.applicationName, stockPath, path } = {}) {
    if (stockPath && path) {
      throw new Error('playAudio requires either stockPath or path, not both');
    }
    if (!stockPath && !path) {
      throw new Error('playAudio requires stockPath or path');
    }
    const payload = stockPath
      ? { application_name: applicationName, stock_path: stockPath }
      : { application_name: applicationName, path };

    const { ok, status, body } = await this._request('POST', '/api/audio/play', {
      jsonBody: payload,
    });
    return { ok, status, body };
  }

  async stopAudio() {
    const { ok, status, body } = await this._request('DELETE', '/api/audio/play');
    return { ok, status, body };
  }

  async setVolume(volume) {
    const v = Math.max(0, Math.min(100, Math.round(Number(volume))));
    const { ok, status, body } = await this._request('POST', `/api/audio/volume?volume=${v}`);
    return { ok, status, body };
  }

  async listStorage(dirPath = '/ext') {
    const { ok, status, body } = await this._request(
      'GET',
      `/api/storage/list?path=${encodeURIComponent(dirPath)}`
    );
    return { ok, status, body };
  }

  async sendInput(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) throw new Error('sendInput requires key');
    const { ok, status, body } = await this._request(
      'POST',
      `/api/input?key=${encodeURIComponent(k)}`
    );
    return { ok, status, body };
  }

  async getScreenBmp(display = 0) {
    const { ok, status, body } = await this._request(
      'GET',
      `/api/screen?display=${Number(display) ? 1 : 0}`,
      { binary: true }
    );
    if (!ok) {
      throw new Error(`GET /api/screen failed (${status})`);
    }
    return body;
  }
}
