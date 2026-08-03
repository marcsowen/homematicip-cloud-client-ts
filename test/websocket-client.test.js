import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {HmIPWebSocketClient} from '../dist/websocket-client.js';

const log = {debug() {}, error() {}, info() {}, warn() {}};

function createHarness() {
  const sockets = [];
  const intervals = [];
  const timeouts = [];
  class FakeWebSocket extends EventEmitter {
    readyState = 0;
    pingCalls = 0;
    terminateCalls = 0;
    close() {
      this.readyState = 3;
      this.emit('close');
    }
    ping() { this.pingCalls += 1; }
    terminate() {
      this.terminateCalls += 1;
      this.readyState = 3;
      this.emit('close');
    }
  }
  const createTimer = (timers, callback, delay) => {
    const timer = {callback, cleared: false, delay};
    timers.push(timer);
    return timer;
  };
  const clearTimer = timer => { timer.cleared = true; };
  return {
    options: {
      clearInterval: clearTimer,
      clearTimeout: clearTimer,
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      pingIntervalMillis: 50,
      reconnectBaseMillis: 100,
      reconnectMaxMillis: 400,
      setInterval: (callback, delay) => createTimer(intervals, callback, delay),
      setTimeout: (callback, delay) => createTimer(timeouts, callback, delay),
    },
    pending: timers => timers.filter(timer => !timer.cleared),
    intervals,
    sockets,
    timeouts,
  };
}

test('heartbeat reconnects an unresponsive connection and stop clears timers', () => {
  const harness = createHarness();
  const client = new HmIPWebSocketClient(
    log,
    'wss://ws.example',
    {AUTHTOKEN: 'token', CLIENTAUTH: 'client-token'},
    harness.options,
  );

  client.start(() => {});
  const socket = harness.sockets[0];
  socket.readyState = 1;
  socket.emit('open');
  const heartbeat = harness.pending(harness.intervals)[0];
  heartbeat.callback();
  assert.equal(socket.pingCalls, 1);
  heartbeat.callback();
  assert.equal(socket.terminateCalls, 1);
  assert.equal(harness.pending(harness.timeouts).length, 1);

  client.stop();
  assert.equal(harness.pending(harness.intervals).length, 0);
  assert.equal(harness.pending(harness.timeouts).length, 0);
});
