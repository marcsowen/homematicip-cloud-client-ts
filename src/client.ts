import * as crypto from 'node:crypto';
import {createRequire} from 'node:module';
import * as os from 'node:os';
import {HmIPHttpClient, type HmIPHttpError, type HmIPHttpResult} from './http-client.js';
import type {HmIPLogger} from './logger.js';
import {
  type HmIPState,
  type HmIPStateChange,
  parseHmIPState,
  parseHmIPStateChange,
} from './state.js';
import {HmIPWebSocketClient, type HmIPWebSocketOptions} from './websocket-client.js';

export type {HmIPWebSocketOptions as HmIPClientWebSocketOptions} from './websocket-client.js';

interface PackageMetadata {
  name: string;
  version: string;
}

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json') as PackageMetadata;

export interface HmIPClientConfig {
  accessPoint: string;
  authToken?: string | undefined;
  pin?: string | undefined;
  applicationIdentifier?: string | undefined;
  applicationVersion?: string | undefined;
  deviceName?: string | undefined;
  language?: string | undefined;
}

export interface HmIPClientOptions {
  fetch?: typeof globalThis.fetch | undefined;
  webSocket?: HmIPWebSocketOptions | undefined;
}

export interface HmIPAuthTokenResult {
  authToken: string;
}

export interface HmIPConfirmTokenResult {
  clientId: string;
}

export type HmIPPairingAcknowledgement =
  | {status: 'acknowledged'}
  | {status: 'pending'}
  | {status: 'failed'; error: HmIPHttpError};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REQUEST_TIMEOUT_MILLIS = 30000;
const REST_PROTOCOLS = new Set(['http:', 'https:']);
const WEBSOCKET_PROTOCOLS = new Set(['ws:', 'wss:']);

interface HmIPEndpoints {
  rest: URL;
  webSocket: URL;
}

function parseEndpoint(value: string, protocols: ReadonlySet<string>): URL | undefined {
  try {
    const url = new URL(value);
    return protocols.has(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

export class HmIPClient {

  private readonly accessPoint: string;
  private readonly authToken: string;
  private readonly clientAuthToken: string;
  private readonly pin: string;
  public readonly clientCharacteristics: Record<string, unknown>;

  private readonly log: HmIPLogger;
  private readonly fetchImplementation: typeof fetch;
  private readonly deviceName: string;
  private endpoints: HmIPEndpoints | undefined;
  private initialization: Promise<boolean> | undefined;
  private readonly shutdownController = new AbortController();

  private httpClient: HmIPHttpClient | undefined;
  private readonly webSocketOptions: HmIPWebSocketOptions;
  private webSocketClient: HmIPWebSocketClient | undefined;

  constructor(log: HmIPLogger, config: HmIPClientConfig, options: HmIPClientOptions = {}) {
    this.log = log;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.webSocketOptions = options.webSocket ?? {};
    this.authToken = config.authToken ?? '';
    this.pin = config.pin ?? '';
    this.accessPoint = config.accessPoint
      ? config.accessPoint.replace(/[^a-fA-F0-9 ]/g, '').toUpperCase()
      : '';
    const applicationIdentifier = config.applicationIdentifier ?? packageMetadata.name;
    const applicationVersion = config.applicationVersion ?? packageMetadata.version;
    this.deviceName = config.deviceName ?? applicationIdentifier;
    this.clientCharacteristics = {
      'clientCharacteristics':
        {
          'apiVersion': '10',
          applicationIdentifier,
          applicationVersion,
          'deviceManufacturer': 'none',
          'deviceType': 'Computer',
          'language': config.language ?? 'de_DE',
          'osType': os.type(),
          'osVersion': os.release(),
        },
      'id': this.accessPoint,
    };

    this.clientAuthToken = crypto
      .createHash('sha512')
      .setEncoding('utf-8')
      .update(`${this.accessPoint}jiLpVitHvWnIGD1yo7MA`)
      .digest('hex')
      .toUpperCase();
  }

  isReadyForUse(): boolean {
    return Boolean(this.accessPoint && this.authToken);
  }

  isReadyForPairing(): boolean {
    return Boolean(this.accessPoint);
  }

  async init(signal?: AbortSignal): Promise<boolean> {
    if (this.shutdownController.signal.aborted) {
      return false;
    }
    if (this.endpoints) {
      return true;
    }
    if (!this.initialization) {
      this.initialization = this.lookupEndpoints(signal)
        .then(endpoints => {
          if (endpoints === false) {
            return false;
          }
          this.endpoints = endpoints;
          this.httpClient = new HmIPHttpClient(
            this.log,
            endpoints.rest,
            {
              authToken: this.authToken,
              clientAuthToken: this.clientAuthToken,
              pin: this.pin,
            },
            {fetch: this.fetchImplementation},
          );
          return true;
        })
        .finally(() => {
          this.initialization = undefined;
        });
    }
    return this.initialization;
  }

  private async lookupEndpoints(signal?: AbortSignal): Promise<HmIPEndpoints | false> {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'VERSION': '12',
      'AUTHTOKEN': '',
      'CLIENTAUTH': this.clientAuthToken,
    };
    try {
      const response = await this.fetchImplementation('https://lookup.homematic.com:48335/getHost', {
        method: 'POST',
        headers,
        body: JSON.stringify(this.clientCharacteristics),
        signal: this.createRequestSignal(signal),
      });
      if (!response.ok) {
        this.log.error('Cannot look up Homematic IP endpoint: HTTP %d %s', response.status, response.statusText);
        return false;
      }
      const result: unknown = await response.json();
      if (!isRecord(result) || typeof result.urlREST !== 'string' || typeof result.urlWebSocket !== 'string') {
        this.log.error('Cannot look up Homematic IP endpoint: response has an invalid shape');
        return false;
      }
      const rest = parseEndpoint(result.urlREST, REST_PROTOCOLS);
      const webSocket = parseEndpoint(result.urlWebSocket, WEBSOCKET_PROTOCOLS);
      if (!rest || !webSocket) {
        this.log.error('Cannot look up Homematic IP endpoint: response contains invalid endpoint URLs');
        return false;
      }
      return {rest, webSocket};
    } catch (error) {
      if (!this.shutdownController.signal.aborted && !signal?.aborted) {
        this.log.error('Cannot look up Homematic IP endpoint: %s', HmIPClient.errorMessage(error));
      }
      return false;
    }
  }

  async apiCall(path: string, body?: Record<string, unknown>, priority = 5,
    signal?: AbortSignal): Promise<unknown | false> {
    const result = await this.request(true, true, path, body, priority, signal);
    return result.ok ? result.body : false;
  }

  async command(path: string, body: Record<string, unknown>, priority = 5): Promise<void> {
    const result = await this.apiCall(path, body, priority);
    if (result === false) {
      throw new Error(`Homematic IP command failed: ${path}`);
    }
  }

  async getCurrentState(signal?: AbortSignal): Promise<HmIPState | false> {
    const result = await this.request(true, true, 'home/getCurrentState',
      this.clientCharacteristics, 1, signal);
    if (!result.ok) {
      return false;
    }
    const state = parseHmIPState(result.body);
    if (!state.success) {
      if (result.body !== false) {
        this.log.error('Homematic IP returned an invalid home state response: %s.', state.error);
      }
      return false;
    }
    return state.value;
  }

  connect(listener: (stateChange: HmIPStateChange) => void): void {
    if (this.shutdownController.signal.aborted) {
      return;
    }
    if (!this.endpoints) {
      this.log.error('Cannot connect Homematic IP websocket before client initialization.');
      return;
    }
    if (!this.webSocketClient) {
      this.webSocketClient = new HmIPWebSocketClient(
        this.log,
        this.endpoints.webSocket.toString(),
        {
          'AUTHTOKEN': this.authToken,
          'CLIENTAUTH': this.clientAuthToken,
        },
        this.webSocketOptions,
      );
    }
    this.webSocketClient.start(data => {
      let parsedMessage: unknown;
      try {
        parsedMessage = JSON.parse(data.toString()) as unknown;
      } catch (error) {
        this.log.error('Cannot parse Homematic IP websocket message: %s',
          error instanceof Error ? error.message : String(error));
        return;
      }
      const parseResult = parseHmIPStateChange(parsedMessage);
      if (!parseResult.success) {
        this.log.error('Ignoring malformed Homematic IP websocket message: %s', parseResult.error);
        return;
      }
      listener(parseResult.value);
    });
  }

  disconnect(): void {
    this.webSocketClient?.stop();
    this.webSocketClient = undefined;
  }

  shutdown(): void {
    this.shutdownController.abort();
    this.httpClient?.shutdown();
    this.disconnect();
  }

  async authConnectionRequest(deviceId: string, signal?: AbortSignal): Promise<boolean> {
    const request = {
      'deviceId': deviceId,
      'deviceName': this.deviceName,
      'sgtin': this.accessPoint,
    };
    const result = await this.request(false, true, 'auth/connectionRequest', request, 0, signal);
    return result.ok && Boolean(result.body);
  }

  async authRequestAcknowledged(
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<HmIPPairingAcknowledgement> {
    const request = {
      'deviceId': deviceId,
    };
    const result = await this.request(false, false, 'auth/isRequestAcknowledged', request, 0, signal);
    if (result.ok) {
      return {status: result.body ? 'acknowledged' : 'pending'};
    }
    if (result.error.kind === 'http' && result.error.status === 400) {
      return {status: 'pending'};
    }
    return {status: 'failed', error: result.error};
  }

  async authRequestToken(deviceId: string, signal?: AbortSignal): Promise<HmIPAuthTokenResult | false> {
    const request = {
      'deviceId': deviceId,
    };
    const result = await this.request(false, true, 'auth/requestAuthToken', request, 0, signal);
    return result.ok && isRecord(result.body) && typeof result.body.authToken === 'string'
      ? {authToken: result.body.authToken}
      : false;
  }

  async authConfirmToken(
    deviceId: string,
    authToken: string,
    signal?: AbortSignal,
  ): Promise<HmIPConfirmTokenResult | false> {
    const request = {
      'deviceId': deviceId,
      'authToken': authToken,
    };
    const result = await this.request(false, true, 'auth/confirmAuthToken', request, 0, signal);
    return result.ok && isRecord(result.body) && typeof result.body.clientId === 'string'
      ? {clientId: result.body.clientId}
      : false;
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private request(authenticated: boolean, logError: boolean, path: string,
    body?: Record<string, unknown>, priority = 5, signal?: AbortSignal): Promise<HmIPHttpResult> {
    if (!this.httpClient) {
      const error: HmIPHttpError = {
        kind: 'not-initialized',
        message: 'client has not been initialized',
        path,
      };
      if (logError) {
        this.log.error('Cannot request %s before client initialization.', path);
      }
      return Promise.resolve({ok: false, error});
    }
    return this.httpClient.request(path, body, {
      authenticated,
      logError,
      priority,
      ...(signal ? {signal} : {}),
    });
  }

  private createRequestSignal(signal?: AbortSignal): AbortSignal {
    const signals = [this.shutdownController.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MILLIS)];
    if (signal) {
      signals.push(signal);
    }
    return AbortSignal.any(signals);
  }

}
