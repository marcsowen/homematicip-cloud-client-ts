import type {HmIPClient} from '../dist/index.js';
declare const client: HmIPClient;
void client.command('setSwitchState', {deviceId: 'device', channelIndex: 1, on: true});
void client.command('setHeatingSetPointTemperature', {groupId: 'group', setPointTemperature: 21}, {signal: new AbortController().signal});
// @ts-expect-error a switch requires a boolean
void client.command('setSwitchState', {deviceId: 'device', channelIndex: 1, on: 'true'});
// @ts-expect-error missing channel address
void client.command('setDimLevel', {deviceId: 'device', dimLevel: 0.5});
// @ts-expect-error unknown operations belong in the explicit raw API
void client.command('device/control/unknownOperation', {});
// @ts-expect-error positional priorities were removed
void client.command('stop', {deviceId: 'device', channelIndex: 1}, 2);
void client.apiCall('device/control/newOperation', {}, {priority: 2});

void client.deviceCommand('setSwitchState', {deviceId: 'device', channelIndex: 1}, {on: true});
// @ts-expect-error Device commands require the correct payload.
void client.deviceCommand('setSwitchState', {deviceId: 'device', channelIndex: 1}, {dimLevel: 1});
// @ts-expect-error URL paths belong to the raw API, not typed commands.
void client.command('device/control/setSwitchState', {deviceId: 'device', channelIndex: 1, on: true});
