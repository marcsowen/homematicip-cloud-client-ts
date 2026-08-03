# homematicip-cloud-client-ts

[![npm](https://img.shields.io/npm/v/homematicip-cloud-client-ts.svg?style=plastic)](https://www.npmjs.com/package/homematicip-cloud-client-ts)
[![npm](https://img.shields.io/npm/dt/homematicip-cloud-client-ts.svg?style=plastic)](https://www.npmjs.com/package/homematicip-cloud-client-ts)
[![GitHub last commit](https://img.shields.io/github/last-commit/marcsowen/homematicip-cloud-client-ts.svg?style=plastic)](https://github.com/marcsowen/homematicip-cloud-client-ts)
![GitHub build](https://img.shields.io/github/actions/workflow/status/marcsowen/homematicip-cloud-client-ts/main.yml?style=plastic)

Unofficial TypeScript and JavaScript client for the Homematic IP Cloud REST and WebSocket APIs used by the Homematic IP Access Point.

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

if (await client.init()) {
  const state = await client.getCurrentState();
  if (state) {
    console.log(Object.values(state.devices));
  }

  client.connect(change => {
    console.log(change.events);
  });
}

process.once('SIGTERM', () => client.shutdown());
```

The package includes strict TypeScript definitions and runtime validation for complete home-state responses and WebSocket change events.

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

When pairing an HCU, press the button on top of the unit before calling `authConnectionRequest()`. The HCU then allows
five minutes to complete registration. The remaining pairing operations are the same as for an HmIP-HAP.

## License

Apache-2.0
