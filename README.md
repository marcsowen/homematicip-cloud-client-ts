# homematicip-cloud-client-ts

[![npm](https://img.shields.io/npm/v/homematicip-cloud-client-ts.svg?style=plastic)](https://www.npmjs.com/package/homematicip-cloud-client-ts)
[![npm](https://img.shields.io/npm/dt/homematicip-cloud-client-ts.svg?style=plastic)](https://www.npmjs.com/package/homematicip-cloud-client-ts)
[![GitHub last commit](https://img.shields.io/github/last-commit/marcsowen/homematicip-cloud-client-ts.svg?style=plastic)](https://github.com/marcsowen/homematicip-cloud-client-ts)
![GitHub build](https://img.shields.io/github/actions/workflow/status/marcsowen/homematicip-cloud-client-ts/main.yml?style=plastic)

Unofficial TypeScript and JavaScript client for the Homematic IP Cloud REST and WebSocket APIs used by the Homematic IP
Access Point and Home Control Unit.

> This project is not affiliated with or endorsed by eQ-3 AG. The cloud API is unofficial and may change without notice.

## Installation

```shell
pnpm add homematicip-cloud-client-ts
```

## Usage

```ts
import {HmIPClient} from 'homematicip-cloud-client-ts';

const client = new HmIPClient(console, {
  accessPoint: process.env.HMIP_ACCESS_POINT ?? '',
  authToken: process.env.HMIP_AUTH_TOKEN,
  applicationIdentifier: 'my-homematicip-integration',
  applicationVersion: '1.0.0',
});

await client.init();
const state = await client.getCurrentState();
console.log(Object.keys(state.devices));
await client.command('setSwitchState', {
  deviceId: 'DEVICE_ID', channelIndex: 1, on: true,
});
client.shutdown();
```

The package includes TypeScript definitions and runtime validation for home-state responses and WebSocket events.
Node.js 24 and 26 are supported.

### Synchronized sessions

Use `HmIPSession` for a long-running integration. It owns initialization, the WebSocket connection, snapshot recovery,
event buffering and failure retries. Do not call `connect()` or `disconnect()` separately while a session owns the client.

```ts
import {HmIPSession} from 'homematicip-cloud-client-ts';

const session = new HmIPSession(client, {
  snapshot: async state => { /* Reconcile devices, groups and home state. */ },
  change: async (change, state) => { /* Apply changes; state already includes the whole event batch. */ },
  status: status => { /* Treat accessories as available only when status === 'ready'. */ },
  error: error => console.warn(error.message),
});
await session.start();
// On shutdown:
await session.stop();
client.shutdown();
```

Status is `connecting`, `synchronizing`, `ready`, `disconnected`, or `stopped`. A live WebSocket alone does not mean state
is synchronized. Observers run in order and may return promises; readiness follows successful snapshot application.
`start()` performs the first initialization/snapshot attempt; it does not wait indefinitely for connectivity. Recovery
continues in the background. A bootstrap snapshot can discover devices before the WebSocket is connected, but is not
marked ready. Successful sessions do not poll periodically.

State changes received during a snapshot are merged before publishing it. Transient channel/button events are delivered
once after that snapshot, not stored as device state. A disconnect cancels the old generation and discards its pending
events. Events lost while offline cannot be reconstructed from snapshots. `maxBufferedEvents` (default 10,000) bounds the
buffer; overflow reports an error and starts fresh synchronization rather than publishing incomplete state.

Snapshots and delivered events are deeply frozen at runtime. The snapshot collections are read-only in TypeScript.
Use `reduceHmIPState()` for independent, non-mutating state reduction, and `getHmIPDeviceReachability()` to distinguish
cloud radio faults from unknown reachability. Protocol presentation and device mapping remain the integration's job.

### Requests and errors

`init()` resolves to `void`; `getCurrentState()` returns a validated state. They reject with `HmIPClientError` on failure,
as do `apiCall()` and `command()`. Errors expose `kind`, `path`, and optional HTTP `status` without request/response bodies.
Kinds include `network`, `timeout`, `aborted`, `http`, `invalid-json`, `invalid-response`, `queue-full`, and `command-rejected`.

`command(operation, body, {signal?, priority?})` checks known request bodies at compile time. Cloud values use native API units.
Operation names such as `setSwitchState` and `setHeatingControlMode` do not expose HTTP paths.
`deviceCommand(operation, {deviceId, channelIndex}, payload, options)` is the device-scoped equivalent.
All endpoint routing belongs to the client. Use `apiCall(path, body, options)` as an explicit escape hatch for new operations. Smaller priorities run first, default 5.
Commands are not automatically retried: repeating an actuator operation after a timeout could repeat a physical action.

Low-level `connect(onChange, onConnection?)` remains available for consumers that implement their own synchronization.
Connection notifications are `connected`, `disconnected`, and `reconnected`; low-level callbacks are synchronous.

### Migrating from 0.3

- Replace boolean checks around `init()`/`getCurrentState()` with `try`/`catch`.
- Replace positional request priorities/signals with an options object.
- Replace duplicated snapshot/reconnect logic with `HmIPSession`.
- Treat snapshots as read-only; do not mutate client-owned state.
- Pairing retains its explicit acknowledgement/pending/failure results; it is not managed by a session.

### Validation diagnostics

Invalid home-state and WebSocket payloads are logged with the failing field and a diagnostic snapshot of only the
rejected object. Diagnostics are limited to 4,000 characters and redact credentials, PINs, controller and device
identifiers, serialized trade numbers, groups, and user-defined labels. Review diagnostic output before sharing it in a
public issue because the unofficial API may add fields that the client does not know are sensitive yet.

Successful HTTP response bodies are omitted from debug logs, including pairing responses. Malformed JSON error logs
omit parser messages that could contain payload fragments. Structured validation diagnostics retain their existing redaction.

## Authentication

Pairing is deliberately exposed as individual operations so applications can provide their own UI and cancellation behaviour:

- `authConnectionRequest()`
- `authRequestAcknowledged()`
- `authRequestToken()`
- `authConfirmToken()`

The link button on the Homematic IP Access Point must be pressed while pairing. Store the returned authentication token securely.

### Home Control Unit (HmIP-HCU1)

The client supports the HmIP-HCU1 through the same cloud API. The HCU requires its Access Point ID on REST and WebSocket
connections. This is handled automatically.

HCU devices with the `PLUGIN_EXTERNAL` archetype are accepted and normalized so an application can either support or
deliberately ignore them without rejecting the complete home state.

When pairing an HCU, press the button on top of the unit before calling `authConnectionRequest()`. The HCU then allows
five minutes to complete registration. The remaining pairing operations are the same as for an HmIP-HAP.

## License

Apache-2.0
