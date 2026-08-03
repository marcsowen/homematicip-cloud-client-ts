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

test('reports the state entry that failed validation', () => {
  assert.deepEqual(parseHmIPState({
    devices: {brokenDevice: {id: 'brokenDevice'}},
    groups: {},
    home: state.home,
  }), {success: false, error: 'device brokenDevice is invalid'});
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
    error: 'event brokenDevice: DEVICE_ADDED.device is invalid',
  });
});
