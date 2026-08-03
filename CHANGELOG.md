# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-03

### Added

- HmIP-HCU1 support through the Access Point identification required for REST, WebSocket, and pairing requests.
- HCU-specific pairing guidance.

## [0.1.0] - 2026-08-03

### Added

- Initial TypeScript and JavaScript client for the Homematic IP Cloud API.
- Access Point endpoint discovery and authentication-token pairing operations.
- Authenticated REST requests with prioritization, rate limiting, timeouts, cancellation, and structured errors.
- Resilient WebSocket updates with heartbeat monitoring and bounded reconnect backoff.
- Typed home-state and state-change models with runtime response validation.
- Configurable application identity, logger, `fetch`, and WebSocket implementations.
- ESM package exports with TypeScript declarations and source maps.

[0.2.0]: https://github.com/marcsowen/homematicip-cloud-client-ts/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/marcsowen/homematicip-cloud-client-ts/releases/tag/v0.1.0
