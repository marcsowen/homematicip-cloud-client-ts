import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {HmIPClient} from '../dist/index.js';

function createLog() {
  const errors = [];
  return {
    errors,
    log: {debug() {}, error: (...args) => errors.push(args), info() {}, warn() {}},
  };
}

const endpoints = {urlREST: 'https://rest.example', urlWebSocket: 'wss://ws.example'};

test('shares and caches endpoint initialization', async () => {
  const {log} = createLog();
  let lookupCalls = 0;
  const client = new HmIPClient(log, {accessPoint: '3014-1234', authToken: 'token'}, {
    fetch: async url => {
      assert.equal(url, 'https://lookup.homematic.com:48335/getHost');
      lookupCalls += 1;
      await Promise.resolve();
      return new Response(JSON.stringify(endpoints), {
        headers: {'content-type': 'application/json'},
        status: 200,
      });
    },
  });

  assert.deepEqual(await Promise.all([client.init(), client.init()]), [true, true]);
  assert.equal(await client.init(), true);
  assert.equal(lookupCalls, 1);
  client.shutdown();
});

test('validates endpoints and current-state responses', async () => {
  const {log} = createLog();
  const invalidEndpoints = new HmIPClient(log, {accessPoint: '3014-1234'}, {
    fetch: async () => new Response(JSON.stringify({
      urlREST: 'ftp://rest.example',
      urlWebSocket: 'https://ws.example',
    }), {headers: {'content-type': 'application/json'}, status: 200}),
  });
  assert.equal(await invalidEndpoints.init(), false);
  invalidEndpoints.shutdown();

  let requests = 0;
  const invalidState = new HmIPClient(log, {accessPoint: '3014-1234', authToken: 'token'}, {
    fetch: async () => {
      requests += 1;
      const body = requests === 1 ? endpoints : {devices: {}, groups: {}, home: {}};
      return new Response(JSON.stringify(body), {
        headers: {'content-type': 'application/json'},
        status: 200,
      });
    },
  });
  assert.equal(await invalidState.init(), true);
  assert.equal(await invalidState.getCurrentState(), false);
  invalidState.shutdown();
});

test('connect emits typed events and ignores malformed messages', async () => {
  const {errors, log} = createLog();
  class FakeWebSocket extends EventEmitter {
    close() {}
    ping() {}
  }
  const socket = new FakeWebSocket();
  const client = new HmIPClient(log, {accessPoint: '3014-1234', authToken: 'token'}, {
    fetch: async () => new Response(JSON.stringify(endpoints), {
      headers: {'content-type': 'application/json'},
      status: 200,
    }),
    webSocket: {createWebSocket: () => socket},
  });
  assert.equal(await client.init(), true);

  const changes = [];
  client.connect(change => changes.push(change));
  socket.emit('message', Buffer.from('{invalid'));
  socket.emit('message', Buffer.from(JSON.stringify({events: {
    event1: {pushEventType: 'DEVICE_CHANNEL_EVENT', deviceId: 'button1'},
  }})));

  assert.equal(errors.length, 1);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].events.event1.deviceId, 'button1');
  client.shutdown();
});

test('command rejects unsuccessful API calls', async () => {
  const {log} = createLog();
  const client = new HmIPClient(log, {accessPoint: '3014-1234', authToken: 'token'});
  client.apiCall = async () => false;
  await assert.rejects(
    client.command('device/control/setSwitchState', {on: true}),
    /Homematic IP command failed/,
  );
  client.shutdown();
});
