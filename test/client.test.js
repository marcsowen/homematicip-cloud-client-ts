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

test('validates endpoints and logs redacted current-state diagnostics', async () => {
  const {errors, log} = createLog();
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
      const body = requests === 1 ? endpoints : {
        devices: {broken: {
          id: 'private-device-id',
          type: 'PLUGIN_EXTERNAL',
          label: 'Private room',
          authToken: 'auth-secret',
          homeId: 'private-home-id',
          functionalChannels: null,
        }},
        groups: {},
        home: {id: 'home1', currentAPVersion: '1.0.0', functionalHomes: {}},
      };
      return new Response(JSON.stringify(body), {
        headers: {'content-type': 'application/json'},
        status: 200,
      });
    },
  });
  assert.equal(await invalidState.init(), true);
  assert.equal(await invalidState.getCurrentState(), false);
  const diagnosticLog = errors.at(-1).join(' ');
  assert.match(diagnosticLog, /functionalChannels must be an object/);
  assert.match(diagnosticLog, /Redacted diagnostic/);
  for (const secret of ['private-device-id', 'Private room', 'auth-secret', 'private-home-id']) {
    assert.doesNotMatch(diagnosticLog, new RegExp(secret));
  }
  invalidState.shutdown();
});

test('connect emits typed events and ignores malformed messages', async () => {
  const {errors, log} = createLog();
  let socketOptions;
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
    webSocket: {createWebSocket: (_url, options) => {
      socketOptions = options;
      return socket;
    }},
  });
  assert.equal(await client.init(), true);

  const changes = [];
  client.connect(change => changes.push(change));
  assert.equal(socketOptions.headers['ACCESSPOINT-ID'], '30141234');
  socket.emit('message', Buffer.from('{invalid'));
  socket.emit('message', Buffer.from(JSON.stringify({events: {
    event1: {pushEventType: 'DEVICE_CHANNEL_EVENT', deviceId: 'button1'},
  }})));

  assert.equal(errors.length, 1);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].events.event1.deviceId, 'button1');
  client.shutdown();
});

test('includes the Access Point ID required for HCU pairing', async () => {
  const {log} = createLog();
  const requests = [];
  const responses = [
    new Response(JSON.stringify(true), {headers: {'content-type': 'application/json'}, status: 200}),
    new Response(JSON.stringify(true), {headers: {'content-type': 'application/json'}, status: 200}),
  ];
  const client = new HmIPClient(log, {accessPoint: '3014-1234'}, {
    fetch: async (url, options) => {
      if (url === 'https://lookup.homematic.com:48335/getHost') {
        return new Response(JSON.stringify(endpoints), {
          headers: {'content-type': 'application/json'},
          status: 200,
        });
      }
      requests.push({options, url});
      return responses.shift();
    },
  });
  assert.equal(await client.init(), true);

  assert.equal(await client.authConnectionRequest('client-id'), true);
  assert.deepEqual(await client.authRequestAcknowledged('client-id'), {status: 'acknowledged'});

  assert.equal(requests[0].options.headers['ACCESSPOINT-ID'], '30141234');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    deviceId: 'client-id',
    deviceName: 'homematicip-cloud-client-ts',
    sgtin: '30141234',
  });
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    deviceId: 'client-id',
    accessPointId: '30141234',
  });
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
