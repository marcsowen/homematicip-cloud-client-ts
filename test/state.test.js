import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isHmIPState,
  isHmIPStateChange,
  parseHmIPState,
  parseHmIPStateChange,
} from '../dist/index.js';

const state = {
  devices: {
    device1: {
      id: 'device1',
      type: 'PLUGABLE_SWITCH',
      label: 'Switch',
      oem: 'eq-3',
      modelType: 'HmIP-PS',
      firmwareVersion: '1.0.0',
      permanentlyReachable: true,
      lastStatusUpdate: 0,
      homeId: 'home1',
      functionalChannels: {},
    },
  },
  groups: {},
  home: {id: 'home1', currentAPVersion: '1.0.0', functionalHomes: {}},
};

test('validates the minimum usable Homematic IP state shape', () => {
  assert.equal(isHmIPState(state), true);
  const {oem: _oem, ...externalDevice} = state.devices.device1;
  assert.equal(isHmIPState({...state, devices: {
    external: {...externalDevice, id: 'external', type: 'EXTERNAL'},
  }}), true);
  assert.equal(isHmIPState({...state, devices: {device1: externalDevice}}), false);
  assert.equal(isHmIPState({...state, home: {}}), false);
});

test('accepts and normalizes HCU plugin devices', () => {
  const pluginDevice = {
    id: '690e2e9f-1111-2222-3333-444444444444',
    type: 'PLUGIN_EXTERNAL',
    homeId: 'home1',
    lastStatusUpdate: 1765536007619,
    label: 'External shutter',
    functionalChannels: {
      0: {functionalChannelType: 'EXTERNAL_BASE_CHANNEL'},
      1: {functionalChannelType: 'GENERIC_WINDOW_COVERING_CHANNEL'},
    },
  };
  const result = parseHmIPState({...state, devices: {plugin: pluginDevice}});
  assert.equal(result.success, true);
  if (!result.success) {
    assert.fail(result.error);
  }
  assert.deepEqual(result.value.devices.plugin, {
    ...pluginDevice,
    modelType: 'PLUGIN_EXTERNAL',
    firmwareVersion: '',
    permanentlyReachable: false,
  });
});

test('reports the state entry that failed validation', () => {
  assert.deepEqual(parseHmIPState({
    devices: {brokenDevice: {id: 'brokenDevice'}},
    groups: {},
    home: state.home,
  }), {
    success: false,
    error: 'device at key [REDACTED] is invalid: type must be a string',
    diagnostic: '{"id":"[REDACTED]"}',
  });
});

test('redacts sensitive values from validation diagnostics', () => {
  const result = parseHmIPState({
    devices: {
      secretDevice: {
        id: '690e2e9f-1111-2222-3333-444444444444',
        type: 'PLUGIN_EXTERNAL',
        label: 'Private room',
        authToken: 'auth-secret',
        authorizationPin: '1234',
        homeId: 'private-home-id',
        functionalChannels: null,
      },
    },
    groups: {},
    home: state.home,
  });
  assert.equal(result.success, false);
  if (result.success) {
    assert.fail('Expected validation to fail');
  }
  assert.match(result.error, /functionalChannels must be an object/);
  assert.match(result.diagnostic, /PLUGIN_EXTERNAL/);
  for (const secret of [
    '690e2e9f-1111-2222-3333-444444444444',
    'Private room',
    'auth-secret',
    '1234',
    'private-home-id',
  ]) {
    assert.doesNotMatch(result.diagnostic, new RegExp(secret));
  }
});

test('validates and normalizes websocket event envelopes', () => {
  assert.equal(isHmIPStateChange({events: []}), false);
  assert.equal(isHmIPStateChange({events: {event1: {}}}), false);
  const result = parseHmIPStateChange({events: {
    channel: {pushEventType: 'DEVICE_CHANNEL_EVENT', deviceId: 'button1'},
    future: {pushEventType: 'FUTURE_EVENT', value: 42},
  }});
  assert.equal(result.success, true);
  if (!result.success) {
    assert.fail(result.error);
  }
  assert.deepEqual(result.value.events.channel, {
    pushEventType: 'DEVICE_CHANNEL_EVENT',
    deviceId: 'button1',
    channelIndex: 1,
    channelEventType: '',
  });
  assert.equal(result.value.events.future?.pushEventType, 'UNKNOWN');
  assert.equal(result.value.events.future?.sourcePushEventType, 'FUTURE_EVENT');
});

test('reports the event that failed websocket validation', () => {
  assert.deepEqual(parseHmIPStateChange({events: {
    brokenDevice: {pushEventType: 'DEVICE_ADDED', device: {id: 'incomplete'}},
  }}), {
    success: false,
    error: 'event at key [REDACTED]: DEVICE_ADDED.device is invalid: type must be a string',
    diagnostic: '{"id":"[REDACTED]"}',
  });
});
