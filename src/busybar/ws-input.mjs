export const BUTTON_NAMES = {
  0: 'ok',
  1: 'back',
  2: 'start',
};

export const ACTION_NAMES = {
  0: 'press',
  1: 'release',
};

const BUTTON_CODE = {
  ok: 0,
  back: 1,
  start: 2,
};

const ACTION_CODE = {
  press: 0,
  release: 1,
};

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return null;
}

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length && pos - offset < 10) {
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, nextPos: pos };
    }
    shift += 7n;
  }
  return null;
}

function readLengthDelimited(buf, offset) {
  const lenRes = readVarint(buf, offset);
  if (!lenRes) return null;
  const len = Number(lenRes.value);
  if (!Number.isSafeInteger(len) || len < 0 || lenRes.nextPos + len > buf.length) {
    return null;
  }
  return {
    slice: buf.subarray(lenRes.nextPos, lenRes.nextPos + len),
    nextPos: lenRes.nextPos + len,
  };
}

function skipField(buf, offset, wireType) {
  if (wireType === 0) {
    const v = readVarint(buf, offset);
    return v ? v.nextPos : null;
  }
  if (wireType === 1) {
    return offset + 8 <= buf.length ? offset + 8 : null;
  }
  if (wireType === 2) {
    const ld = readLengthDelimited(buf, offset);
    return ld ? ld.nextPos : null;
  }
  if (wireType === 5) {
    return offset + 4 <= buf.length ? offset + 4 : null;
  }
  return null;
}

function decodeButtonEvent(buf) {
  let buttonId = 0;
  let actionId = 0;
  let pos = 0;

  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    pos = tagRes.nextPos;
    const tag = Number(tagRes.value & 0xffffffffn);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (fieldNum === 1 && wireType === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      buttonId = Number(v.value & 0xffffffffn);
      pos = v.nextPos;
    } else if (fieldNum === 2 && wireType === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      actionId = Number(v.value & 0xffffffffn);
      pos = v.nextPos;
    } else {
      const next = skipField(buf, pos, wireType);
      if (next === null) break;
      pos = next;
    }
  }

  return {
    button: BUTTON_NAMES[buttonId] || `unknown_${buttonId}`,
    action: ACTION_NAMES[actionId] || `unknown_${actionId}`,
  };
}

function decodeInputEvent(buf, out) {
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    pos = tagRes.nextPos;
    const tag = Number(tagRes.value & 0xffffffffn);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (fieldNum === 1 && wireType === 2) {
      const ld = readLengthDelimited(buf, pos);
      if (!ld) break;
      out.push(decodeButtonEvent(ld.slice));
      pos = ld.nextPos;
    } else {
      const next = skipField(buf, pos, wireType);
      if (next === null) break;
      pos = next;
    }
  }
}

function decodeStateUpdate(buf, out) {
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    pos = tagRes.nextPos;
    const tag = Number(tagRes.value & 0xffffffffn);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (fieldNum === 11 && wireType === 2) {
      const ld = readLengthDelimited(buf, pos);
      if (!ld) break;
      decodeInputEvent(ld.slice, out);
      pos = ld.nextPos;
    } else {
      const next = skipField(buf, pos, wireType);
      if (next === null) break;
      pos = next;
    }
  }
}

/**
 * Decodes `BSB_State.State` protobuf frames from `/api/status/ws` and extracts button events.
 */
export function decodeStatusStateButtons(input) {
  const buf = toUint8Array(input);
  if (!buf || buf.length === 0) return [];

  const events = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    pos = tagRes.nextPos;
    const tag = Number(tagRes.value & 0xffffffffn);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (fieldNum === 2 && wireType === 2) {
      const ld = readLengthDelimited(buf, pos);
      if (!ld) break;
      decodeStateUpdate(ld.slice, events);
      pos = ld.nextPos;
    } else {
      const next = skipField(buf, pos, wireType);
      if (next === null) break;
      pos = next;
    }
  }

  return events;
}

function encodeVarint(n) {
  const out = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function wrapLengthDelimited(fieldNum, bytes) {
  return Buffer.concat([
    Buffer.from(encodeVarint((fieldNum << 3) | 2)),
    Buffer.from(encodeVarint(bytes.length)),
    bytes,
  ]);
}

/**
 * Test helper that encodes button events (and optional noise fields) as a `BSB_State.State` payload.
 */
export function encodeButtonStateForTest(events = [], { includeTimestamp = true, includeFrameNoise = false } = {}) {
  const parts = [];
  if (includeTimestamp) {
    // Field 1, wire type 1 (fixed64)
    parts.push(Buffer.from([0x09, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
  }
  if (includeFrameNoise) {
    const fakeFrame = wrapLengthDelimited(10, Buffer.from([0x10, 0x48, 0x18, 0x10]));
    parts.push(wrapLengthDelimited(2, fakeFrame));
  }
  for (const evt of events) {
    const btn = typeof evt.button === 'number' ? evt.button : (BUTTON_CODE[evt.button] ?? 0);
    const act = typeof evt.action === 'number' ? evt.action : (ACTION_CODE[evt.action] ?? 0);
    const btnFields = [];
    if (btn !== 0) {
      btnFields.push(0x08, ...encodeVarint(btn));
    }
    if (act !== 0) {
      btnFields.push(0x10, ...encodeVarint(act));
    }
    const buttonMsg = Buffer.from(btnFields);
    const inputMsg = wrapLengthDelimited(1, buttonMsg);
    const updateMsg = wrapLengthDelimited(11, inputMsg);
    parts.push(wrapLengthDelimited(2, updateMsg));
  }
  return Buffer.concat(parts);
}

/**
 * Connects to BUSY Bar `/api/status/ws` and triggers configured reset callbacks on hardware button presses.
 */
export class BusyBarInputWatcher {
  constructor({
    baseUrl = 'http://10.0.4.20',
    enabled = true,
    multiButton = false,
    longPressMs = 700,
    resetButton = 'back',
    resetAction = 'press',
    reconnectDelayMs = 3000,
    debounceMs = 500,
    onButton = null,
    onReset = null,
    onGesture = null,
    WebSocketImpl = globalThis.WebSocket,
    nowFn = () => Date.now(),
  } = {}) {
    const u = new URL(String(baseUrl || 'http://10.0.4.20'));
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/api/status/ws';
    u.search = '';
    this.wsUrl = u.toString();

    this.enabled = Boolean(enabled);
    this.multiButton = Boolean(multiButton || onGesture);
    this.longPressMs = Math.max(20, Number(longPressMs ?? 700));
    this.resetButton = resetButton ? String(resetButton).trim().toLowerCase() : null;
    this.resetAction = String(resetAction || 'press').trim().toLowerCase();
    this.reconnectDelayMs = Math.max(50, Number(reconnectDelayMs ?? 3000));
    this.debounceMs = Math.max(0, Number(debounceMs ?? 500));

    this._onButton = onButton;
    this._onReset = onReset;
    this._onGesture = onGesture;
    this._WebSocket = WebSocketImpl;
    this._now = nowFn;

    this._ws = null;
    this._stopped = true;
    this._connected = false;
    this._reconnectTimer = null;
    this._currentDelayMs = this.reconnectDelayMs;
    this._lastResetAt = -Infinity;
    this._lastButtonEvent = null;
    this._pressState = new Map();
  }

  getStatus() {
    return {
      enabled: this.enabled,
      connected: this._connected,
      wsUrl: this.wsUrl,
      multiButton: this.multiButton,
      longPressMs: this.longPressMs,
      resetButton: this.resetButton,
      resetAction: this.resetAction,
      lastButtonEvent: this._lastButtonEvent,
    };
  }

  _clearPressStates() {
    for (const entry of this._pressState.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    }
    this._pressState.clear();
  }

  start() {
    if (!this.enabled || !this._WebSocket) return;
    if (!this._stopped) return;
    this._stopped = false;
    this._currentDelayMs = this.reconnectDelayMs;
    this._connect();
  }

  stop() {
    this._stopped = true;
    this._connected = false;
    this._clearPressStates();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    const delay = this._currentDelayMs;
    const maxDelay = Math.max(this.reconnectDelayMs, 10000);
    this._currentDelayMs = Math.min(maxDelay, delay * 2);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._stopped) this._connect();
    }, delay);
  }

  async _handleMessage(data) {
    if (typeof data === 'string') return;
    let payload = data;
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      payload = await data.arrayBuffer();
    }
    const events = decodeStatusStateButtons(payload);
    if (events.length === 0) return;

    const now = this._now();
    for (const evt of events) {
      this._lastButtonEvent = { ...evt, atMs: now };
      try {
        this._onButton?.(evt);
      } catch {
        // Isolate user callback errors.
      }
      if (this._onGesture) {
        await this._handleGestureEvent(evt, now);
      } else if (
        this.resetButton &&
        evt.button === this.resetButton &&
        evt.action === this.resetAction &&
        now - this._lastResetAt >= this.debounceMs
      ) {
        this._lastResetAt = now;
        try {
          await this._onReset?.(evt);
        } catch {
          // Isolate reset handler errors.
        }
      }
    }
  }

  async _handleGestureEvent(evt, now) {
    if (evt.action === 'press') {
      const existing = this._pressState.get(evt.button);
      if (existing?.timer) {
        clearTimeout(existing.timer);
      }
      const entry = {
        pressAtMs: now,
        longFired: false,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (this._stopped) return;
        entry.longFired = true;
        Promise.resolve(
          this._onGesture?.({
            button: evt.button,
            gesture: 'long_press',
            durationMs: this.longPressMs,
          })
        ).catch(() => {});
      }, this.longPressMs);
      this._pressState.set(evt.button, entry);
      return;
    }

    if (evt.action === 'release') {
      const entry = this._pressState.get(evt.button);
      if (!entry) return;
      this._pressState.delete(evt.button);
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (!entry.longFired) {
        try {
          await this._onGesture?.({
            button: evt.button,
            gesture: 'short_press',
            durationMs: Math.max(0, now - entry.pressAtMs),
          });
        } catch {
          // Isolate gesture handler errors.
        }
      }
    }
  }

  _connect() {
    if (this._stopped || !this._WebSocket) return;
    let ws;
    try {
      ws = new this._WebSocket(this.wsUrl);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      // Ignore if mock WebSocket doesn't expose writable binaryType.
    }

    ws.addEventListener('open', () => {
      if (this._stopped || this._ws !== ws) return;
      this._connected = true;
      this._currentDelayMs = this.reconnectDelayMs;
      try {
        ws.send(JSON.stringify({ enable: true }));
      } catch {
        // Ignore send errors; close handler will reconnect.
      }
    });

    ws.addEventListener('message', (ev) => {
      if (this._stopped || this._ws !== ws) return;
      this._handleMessage(ev.data).catch(() => {});
    });

    ws.addEventListener('close', () => {
      if (this._ws === ws) {
        this._ws = null;
        this._connected = false;
      }
      this._clearPressStates();
      if (!this._stopped) this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // Close event typically follows; ensure reconnect if socket never opened.
      if (this._ws === ws && !this._connected && !this._stopped) {
        this._scheduleReconnect();
      }
    });
  }
}
