import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BusyBarInputWatcher,
  decodeStatusStateButtons,
  encodeButtonStateForTest,
} from '../src/busybar/ws-input.mjs';

test('decodeStatusStateButtons decodes proto3 omitted defaults, back/start actions, and mixed frame noise', () => {
  // Raw empty ButtonEvent (ok + press): State.updates(2) -> Input(11) -> ButtonEvent(1) = empty (0a 00)
  const okPress = encodeButtonStateForTest([{ button: 'ok', action: 'press' }], {
    includeTimestamp: false,
  });
  assert.deepEqual(decodeStatusStateButtons(okPress), [{ button: 'ok', action: 'press' }]);

  const multi = encodeButtonStateForTest(
    [
      { button: 'back', action: 'press' },
      { button: 'back', action: 'release' },
      { button: 'start', action: 'press' },
      { button: 'ok', action: 'release' },
    ],
    { includeTimestamp: true, includeFrameNoise: true }
  );
  assert.deepEqual(decodeStatusStateButtons(multi), [
    { button: 'back', action: 'press' },
    { button: 'back', action: 'release' },
    { button: 'start', action: 'press' },
    { button: 'ok', action: 'release' },
  ]);

  // ArrayBuffer input & malformed/truncated buffers never throw
  const ab = multi.buffer.slice(multi.byteOffset, multi.byteOffset + multi.byteLength);
  assert.equal(decodeStatusStateButtons(ab).length, 4);
  assert.deepEqual(decodeStatusStateButtons(Buffer.from([])), []);
  assert.deepEqual(decodeStatusStateButtons(Buffer.from([0x12, 0x7f, 0x5a])), []);
});

test('BusyBarInputWatcher sends enable, triggers debounced onReset for configured button, and reconnects', async () => {
  const sockets = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.binaryType = 'blob';
      this.sent = [];
      this.closed = false;
      this._listeners = new Map();
      sockets.push(this);
    }

    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }

    emit(type, ev = {}) {
      for (const fn of this._listeners.get(type) || []) {
        fn(ev);
      }
    }

    send(msg) {
      this.sent.push(msg);
    }

    close() {
      this.closed = true;
    }
  }

  let clock = 10_000;
  const seenButtons = [];
  const resetEvents = [];

  const watcher = new BusyBarInputWatcher({
    baseUrl: 'http://10.0.4.20',
    resetButton: 'back',
    resetAction: 'press',
    reconnectDelayMs: 50,
    debounceMs: 500,
    WebSocketImpl: FakeWebSocket,
    nowFn: () => clock,
    onButton: (evt) => seenButtons.push(evt),
    onReset: (evt) => resetEvents.push(evt),
  });

  watcher.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'ws://10.0.4.20/api/status/ws');

  sockets[0].emit('open');
  assert.deepEqual(sockets[0].sent, [JSON.stringify({ enable: true })]);
  assert.equal(watcher.getStatus().connected, true);

  // Non-reset buttons still report to onButton without calling onReset
  await watcher._handleMessage(encodeButtonStateForTest([{ button: 'ok', action: 'press' }]));
  await watcher._handleMessage(encodeButtonStateForTest([{ button: 'back', action: 'release' }]));
  assert.equal(seenButtons.length, 2);
  assert.equal(resetEvents.length, 0);

  // Matching back+press triggers onReset, then debounces rapid second press
  await watcher._handleMessage(encodeButtonStateForTest([{ button: 'back', action: 'press' }]));
  clock += 200;
  await watcher._handleMessage(encodeButtonStateForTest([{ button: 'back', action: 'press' }]));
  assert.equal(resetEvents.length, 1);

  // Past debounce window -> triggers again
  clock += 600;
  await watcher._handleMessage(encodeButtonStateForTest([{ button: 'back', action: 'press' }]));
  assert.equal(resetEvents.length, 2);

  // Close triggers reconnect
  sockets[0].emit('close');
  assert.equal(watcher.getStatus().connected, false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sockets.length, 2);

  watcher.stop();
  assert.equal(sockets[1].closed, true);
});
