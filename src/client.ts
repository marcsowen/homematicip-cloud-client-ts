import * as crypto from 'node:crypto';
import {createRequire} from 'node:module';
import * as os from 'node:os';
import type {HmIPCommandBodies, HmIPDeviceAddress, HmIPDeviceCommandBodies, HmIPRequestOptions} from './commands.js';
import {HmIPClientError} from './errors.js';
import {HmIPHttpClient, type HmIPHttpError, type HmIPHttpResult} from './http-client.js';
import type {HmIPLogger} from './logger.js';
import {
  type HmIPState,
  type HmIPStateChange,
  parseHmIPState,
  parseHmIPStateChange,
} from './state.js';
import type {HmIPConnectionListener} from './websocket-client.js';
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

const COMMAND_PATHS: Record<keyof HmIPCommandBodies, string> = {
  setSwitchState: 'device/control/setSwitchState',
  setDimLevel: 'device/control/setDimLevel',
  setShutterLevel: 'device/control/setShutterLevel',
  setPrimaryShadingLevel: 'device/control/setPrimaryShadingLevel',
  setSlatsLevel: 'device/control/setSlatsLevel',
  stop: 'device/control/stop',
  startImpulse: 'device/control/startImpulse',
  setLockState: 'device/control/setLockState',
  sendDoorCommand: 'device/control/sendDoorCommand',
  setWateringSwitchState: 'device/control/setWateringSwitchState',
  setWateringSwitchStateWithTime: 'device/control/setWateringSwitchStateWithTime',
  setWaterSupplyState: 'device/control/setWaterSupplyState',
  setHueSaturationDimLevel: 'device/control/setHueSaturationDimLevel',
  setColorTemperatureDimLevel: 'device/control/setColorTemperatureDimLevel',
  setSimpleRGBColorDimLevel: 'device/control/setSimpleRGBColorDimLevel',
  setOpticalSignal: 'device/control/setOpticalSignal',
  setHeatingControlMode: 'group/heating/setControlMode',
  setHeatingSetPointTemperature: 'group/heating/setSetPointTemperature',
  setSecurityZonesActivation: 'home/security/setZonesActivation',
};

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
  private initialization: Promise<void> | undefined;
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

  async init(signal?: AbortSignal): Promise<void> {
    if (this.shutdownController.signal.aborted) {
      throw new HmIPClientError('aborted', 'lookup/getHost');
    }
    if (this.endpoints) {
      return;
    }
    if (!this.initialization) {
      this.initialization = this.lookupEndpoints(signal)
        .then(endpoints => {
          this.endpoints = endpoints;
          this.httpClient = new HmIPHttpClient(
            this.log,
            endpoints.rest,
            {
              accessPointId: this.accessPoint,
              authToken: this.authToken,
              clientAuthToken: this.clientAuthToken,
              pin: this.pin,
            },
            {fetch: this.fetchImplementation},
          );
        })
        .finally(() => {
          this.initialization = undefined;
        });
    }
    return this.initialization;
  }

  private async lookupEndpoints(signal?: AbortSignal): Promise<HmIPEndpoints> {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'VERSION': '12',
      'AUTHTOKEN': '',
      'CLIENTAUTH': this.clientAuthToken,
    };
    const requestSignal = this.createRequestSignal(signal);
    try {
      const response = await this.fetchImplementation('https://lookup.homematic.com:48335/getHost', {
        method: 'POST', headers, body: JSON.stringify(this.clientCharacteristics), signal: requestSignal,
      });
      if (!response.ok) throw new HmIPClientError('http', 'lookup/getHost', response.status);
      let result: unknown;
      try { result = await response.json(); }
      catch { throw new HmIPClientError('invalid-json', 'lookup/getHost'); }
      if (!isRecord(result) || typeof result.urlREST !== 'string' || typeof result.urlWebSocket !== 'string') {
        throw new HmIPClientError('invalid-response', 'lookup/getHost');
      }
      const rest = parseEndpoint(result.urlREST, REST_PROTOCOLS);
      const webSocket = parseEndpoint(result.urlWebSocket, WEBSOCKET_PROTOCOLS);
      if (!rest || !webSocket) throw new HmIPClientError('invalid-response', 'lookup/getHost');
      requestSignal.throwIfAborted();
      return {rest, webSocket};
    } catch (error) {
      if (requestSignal.aborted) throw new HmIPClientError(
        this.shutdownController.signal.aborted || signal?.aborted ? 'aborted' : 'timeout', 'lookup/getHost');
      throw error instanceof HmIPClientError ? error : new HmIPClientError('network', 'lookup/getHost');
    }
  }

  /** Low-level escape hatch for cloud operations not yet covered by command(). */
  async apiCall(path: string, body?: Record<string, unknown>, options: HmIPRequestOptions = {}): Promise<unknown> {
    const result = await this.request(true, false, path, body, options.priority ?? 5, options.signal);
    if (!result.ok) throw HmIPClientError.fromHttp(result.error);
    return result.body;
  }

  async command<K extends keyof HmIPCommandBodies>(operation: K, body: HmIPCommandBodies[NoInfer<K>],
    options: HmIPRequestOptions = {}): Promise<void> {
    await this.executeCommand(operation, {...body}, options);
  }

  /** Device-scoped commands let adapters keep the address separate from the operation payload. */
  async deviceCommand<K extends keyof HmIPDeviceCommandBodies>(operation: K, address: HmIPDeviceAddress,
    body: HmIPDeviceCommandBodies[NoInfer<K>], options: HmIPRequestOptions = {}): Promise<void> {
    await this.executeCommand(operation, {...body, ...address}, options);
  }

  private async executeCommand(operation: keyof HmIPCommandBodies, body: Record<string, unknown>,
    options: HmIPRequestOptions): Promise<void> {
    const path = COMMAND_PATHS[operation];
    if (!path) throw new TypeError('Unknown Homematic IP command operation.');
    const response = await this.apiCall(path, body, options);
    if (response === false) throw new HmIPClientError('command-rejected', path);
  }

  async getCurrentState(signal?: AbortSignal): Promise<HmIPState> {
    const body = await this.apiCall('home/getCurrentState', this.clientCharacteristics, {priority: 1, ...(signal ? {signal} : {})});
    const state = parseHmIPState(body);
    if (!state.success) {
      this.log.error('Homematic IP returned an invalid home state response: %s.%s',
        state.error, state.diagnostic ? ` Redacted diagnostic: ${state.diagnostic}` : '');
      throw new HmIPClientError('invalid-response', 'home/getCurrentState');
    }
    return state.value;
  }

  connect(listener: (stateChange: HmIPStateChange) => void, connectionListener?: HmIPConnectionListener): void {
    if (this.shutdownController.signal.aborted) {
      return;
    }
    if (!this.endpoints) {
      throw new HmIPClientError('not-initialized', 'websocket/connect');
    }
    if (!this.webSocketClient) {
      this.webSocketClient = new HmIPWebSocketClient(
        this.log,
        this.endpoints.webSocket.toString(),
        {
          'AUTHTOKEN': this.authToken,
          'CLIENTAUTH': this.clientAuthToken,
          'ACCESSPOINT-ID': this.accessPoint,
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
          error instanceof Error ? error.name : 'invalid JSON');
        return;
      }
      const parseResult = parseHmIPStateChange(parsedMessage);
      if (!parseResult.success) {
        this.log.error('Ignoring malformed Homematic IP websocket message: %s.%s',
          parseResult.error,
          parseResult.diagnostic ? ` Redacted diagnostic: ${parseResult.diagnostic}` : '');
        return;
      }
      listener(parseResult.value);
    }, connectionListener);
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
      'accessPointId': this.accessPoint,
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
