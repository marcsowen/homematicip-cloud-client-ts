export interface IdentifiableDevice {
  id: string;
}

export type HmIPStateChangeEvent =
  | {pushEventType: 'GROUP_CHANGED' | 'GROUP_ADDED' | 'GROUP_REMOVED'; group: HmIPGroup}
  | {pushEventType: 'DEVICE_ADDED' | 'DEVICE_CHANGED'; device: HmIPDevice}
  | {pushEventType: 'DEVICE_REMOVED'; device: Pick<HmIPDevice, 'id' | 'modelType'>}
  | {
    pushEventType: 'DEVICE_CHANNEL_EVENT';
    deviceId: string;
    channelIndex: number;
    channelEventType: string;
  }
  | {pushEventType: 'HOME_CHANGED'; home: HmIPHome}
  | {pushEventType: 'SECURITY_JOURNAL_CHANGED'; data: Readonly<Record<string, unknown>>}
  | {pushEventType: 'UNKNOWN'; sourcePushEventType: string; data: Readonly<Record<string, unknown>>};

export interface HmIPStateChange {
  events: Record<string, HmIPStateChangeEvent>;
}

export interface HmIPFunctionalChannel {
  functionalChannelType: string;
}

export interface HmIPDevice extends IdentifiableDevice {
  label: string;
  type: string;
  /** Not supplied for devices with the EXTERNAL or PLUGIN_EXTERNAL archetype. */
  oem?: string;
  modelType: string;
  firmwareVersion: string;
  functionalChannels: Record<string, HmIPFunctionalChannel>;
  permanentlyReachable: boolean;
  lastStatusUpdate: number;
  homeId: string;
}

export interface HmIPGroup extends IdentifiableDevice {
  type: string;
}

export interface HmIPHeatingGroup extends HmIPGroup {
  type: 'HEATING';
  cooling: boolean | null;
  setPointTemperature: number | null;
  actualTemperature: number | null;
  humidity: number | null;
  minTemperature: number | null;
  maxTemperature: number | null;
  controlMode: string | null;
  valvePosition: number | null;
}

export interface HmIPSecurityZoneGroup extends HmIPGroup {
  type: 'SECURITY_ZONE';
  label: string;
  /** Omitted for disarmed zones in request-based security installations. */
  active?: boolean;
}

export interface HmIPHome extends IdentifiableDevice {
  currentAPVersion: string;
  functionalHomes: Record<string, HmIPFunctionalHome>;
}

export interface HmIPFunctionalHome {
  solution: string;
  active: boolean;
}

export interface HmIPSecurityAndAlarmSolution extends HmIPFunctionalHome {
  solution: 'SECURITY_AND_ALARM';
  activationInProgress: boolean;
  intrusionAlarmActive: boolean;
  safetyAlarmActive: boolean;
  alarmActive: boolean;
}

export interface HmIPState {
  devices: Record<string, HmIPDevice>;
  groups: Record<string, HmIPGroup>;
  home: HmIPHome;
}

export interface SabotageChannel {
  functionalChannelType: string;
  sabotage: boolean;
}

export enum MotionDetectionSendInterval {
  SECONDS_30 = 'SECONDS_30',
  SECONDS_60 = 'SECONDS_60',
  SECONDS_120 = 'SECONDS_120',
  SECONDS_240 = 'SECONDS_240',
  SECONDS_480 = 'SECONDS_480'
}

export type HmIPParseResult<T> =
  | {success: true; value: T}
  | {success: false; error: string; diagnostic?: string};

const REDACTED_VALUE = '[REDACTED]';
const MAX_DIAGNOSTIC_LENGTH = 4000;
const sensitiveDiagnosticKeys = new Set([
  'accesspoint',
  'accesspointid',
  'authorization',
  'authtoken',
  'clientauth',
  'clientauthtoken',
  'deviceid',
  'groupid',
  'groups',
  'homeid',
  'id',
  'label',
  'password',
  'pin',
  'secret',
  'serializedglobaltradeitemnumber',
  'sgtin',
  'token',
]);

function normalizeDiagnosticKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = normalizeDiagnosticKey(key);
  return sensitiveDiagnosticKeys.has(normalized)
    || normalized.endsWith('authtoken')
    || normalized.endsWith('authorizationpin')
    || normalized.endsWith('password')
    || normalized.endsWith('secret');
}

function redactDiagnosticValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map(item => redactDiagnosticValue(item, seen));
  }
  if (!isHmIPRecord(value)) {
    return value;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = isSensitiveDiagnosticKey(key)
      ? REDACTED_VALUE
      : redactDiagnosticValue(entry, seen);
  }
  return redacted;
}

export function formatHmIPDiagnostic(value: unknown): string {
  let diagnostic: string;
  try {
    diagnostic = JSON.stringify(redactDiagnosticValue(value, new WeakSet())) ?? String(value);
  } catch {
    diagnostic = '[UNSERIALIZABLE]';
  }
  return diagnostic.length <= MAX_DIAGNOSTIC_LENGTH
    ? diagnostic
    : `${diagnostic.slice(0, MAX_DIAGNOSTIC_LENGTH)}...[TRUNCATED]`;
}

export function isHmIPRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isHmIPFunctionalChannel(value: unknown): value is HmIPFunctionalChannel {
  return isHmIPRecord(value) && typeof value.functionalChannelType === 'string';
}

export function hasFunctionalChannelType<const T extends readonly string[]>(
  channel: HmIPFunctionalChannel,
  ...types: T
): channel is HmIPFunctionalChannel & {functionalChannelType: T[number]} {
  return types.includes(channel.functionalChannelType);
}

function isHmIPExternalDevice(value: Record<string, unknown>): boolean {
  return value.type === 'EXTERNAL'
    || value.type === 'PLUGIN_EXTERNAL'
    || value.deviceArchetype === 'EXTERNAL'
    || value.deviceArchetype === 'PLUGIN_EXTERNAL';
}

function getHmIPDeviceValidationError(value: unknown): string | undefined {
  if (!isHmIPRecord(value)) {
    return 'device must be an object';
  }
  const requiredStrings = ['id', 'type', 'label', 'homeId'] as const;
  for (const field of requiredStrings) {
    if (typeof value[field] !== 'string') {
      return `${field} must be a string`;
    }
  }
  if (!isHmIPRecord(value.functionalChannels)) {
    return 'functionalChannels must be an object';
  }
  for (const [index, channel] of Object.entries(value.functionalChannels)) {
    if (!isHmIPFunctionalChannel(channel)) {
      return `functionalChannels.${index}.functionalChannelType must be a string`;
    }
  }
  if (isHmIPExternalDevice(value)) {
    return undefined;
  }
  if (typeof value.oem !== 'string') {
    return 'oem must be a string';
  }
  if (typeof value.modelType !== 'string') {
    return 'modelType must be a string';
  }
  if (typeof value.firmwareVersion !== 'string') {
    return 'firmwareVersion must be a string';
  }
  if (typeof value.permanentlyReachable !== 'boolean') {
    return 'permanentlyReachable must be a boolean';
  }
  if (typeof value.lastStatusUpdate !== 'number') {
    return 'lastStatusUpdate must be a number';
  }
  return undefined;
}

function normalizeHmIPDevice(value: Record<string, unknown>): HmIPDevice {
  if (!isHmIPExternalDevice(value)) {
    return value as unknown as HmIPDevice;
  }
  return {
    ...value,
    id: value.id as string,
    type: value.type as string,
    label: value.label as string,
    homeId: value.homeId as string,
    modelType: typeof value.modelType === 'string' ? value.modelType : value.type as string,
    firmwareVersion: typeof value.firmwareVersion === 'string' ? value.firmwareVersion : '',
    permanentlyReachable: typeof value.permanentlyReachable === 'boolean' ? value.permanentlyReachable : false,
    lastStatusUpdate: typeof value.lastStatusUpdate === 'number' ? value.lastStatusUpdate : 0,
    functionalChannels: value.functionalChannels as Record<string, HmIPFunctionalChannel>,
  };
}

export function isHmIPDevice(value: unknown): value is HmIPDevice {
  return getHmIPDeviceValidationError(value) === undefined;
}

export function isHmIPHome(value: unknown): value is HmIPHome {
  return getHmIPHomeValidationError(value) === undefined;
}

function getHmIPHomeValidationError(value: unknown): string | undefined {
  if (!isHmIPRecord(value)) {
    return 'home must be an object';
  }
  if (typeof value.id !== 'string') {
    return 'id must be a string';
  }
  if (typeof value.currentAPVersion !== 'string') {
    return 'currentAPVersion must be a string';
  }
  if (!isHmIPRecord(value.functionalHomes)) {
    return 'functionalHomes must be an object';
  }
  for (const [solution, functionalHome] of Object.entries(value.functionalHomes)) {
    if (!isHmIPRecord(functionalHome)) {
      return `functionalHomes.${solution} must be an object`;
    }
    if (typeof functionalHome.solution !== 'string') {
      return `functionalHomes.${solution}.solution must be a string`;
    }
    if (typeof functionalHome.active !== 'boolean') {
      return `functionalHomes.${solution}.active must be a boolean`;
    }
  }
  return undefined;
}

function getHmIPGroupValidationError(value: unknown): string | undefined {
  if (!isHmIPRecord(value)) {
    return 'group must be an object';
  }
  if (typeof value.id !== 'string') {
    return 'id must be a string';
  }
  if (typeof value.type !== 'string') {
    return 'type must be a string';
  }
  return undefined;
}

export function isHmIPHeatingGroup(value: HmIPGroup): value is HmIPHeatingGroup {
  if (value.type !== 'HEATING') {
    return false;
  }
  const candidate: unknown = value;
  return isHmIPRecord(candidate)
    && (candidate.cooling === null || typeof candidate.cooling === 'boolean')
    && (candidate.setPointTemperature === null || typeof candidate.setPointTemperature === 'number')
    && (candidate.actualTemperature === null || typeof candidate.actualTemperature === 'number')
    && (candidate.humidity === null || typeof candidate.humidity === 'number')
    && (candidate.minTemperature === null || typeof candidate.minTemperature === 'number')
    && (candidate.maxTemperature === null || typeof candidate.maxTemperature === 'number')
    && (candidate.controlMode === null || typeof candidate.controlMode === 'string')
    && (candidate.valvePosition === null || typeof candidate.valvePosition === 'number');
}

export function isHmIPSecurityZoneGroup(value: HmIPGroup): value is HmIPSecurityZoneGroup {
  const candidate: unknown = value;
  return value.type === 'SECURITY_ZONE'
    && isHmIPRecord(candidate)
    && typeof candidate.label === 'string'
    && (candidate.active === undefined || typeof candidate.active === 'boolean');
}

export function isHmIPSecurityAndAlarmSolution(
  value: HmIPFunctionalHome,
): value is HmIPSecurityAndAlarmSolution {
  const candidate: unknown = value;
  return value.solution === 'SECURITY_AND_ALARM'
    && isHmIPRecord(candidate)
    && typeof candidate.activationInProgress === 'boolean'
    && typeof candidate.intrusionAlarmActive === 'boolean'
    && typeof candidate.safetyAlarmActive === 'boolean'
    && typeof candidate.alarmActive === 'boolean';
}

export function isHmIPState(value: unknown): value is HmIPState {
  return parseHmIPState(value).success;
}

export function parseHmIPState(value: unknown): HmIPParseResult<HmIPState> {
  if (!isHmIPRecord(value) || !isHmIPRecord(value.devices)
    || !isHmIPRecord(value.groups) || !isHmIPRecord(value.home)) {
    return {success: false, error: 'response must contain devices, groups, and home objects'};
  }

  const homeError = getHmIPHomeValidationError(value.home);
  if (homeError) {
    return {
      success: false,
      error: `home is invalid: ${homeError}`,
      diagnostic: formatHmIPDiagnostic(value.home),
    };
  }

  const devices: Record<string, HmIPDevice> = {};
  for (const [id, device] of Object.entries(value.devices)) {
    const error = getHmIPDeviceValidationError(device);
    if (error) {
      return {
        success: false,
        error: `device at key [REDACTED] is invalid: ${error}`,
        diagnostic: formatHmIPDiagnostic(device),
      };
    }
    devices[id] = normalizeHmIPDevice(device as Record<string, unknown>);
  }

  for (const group of Object.values(value.groups)) {
    const error = getHmIPGroupValidationError(group);
    if (error) {
      return {
        success: false,
        error: `group at key [REDACTED] is invalid: ${error}`,
        diagnostic: formatHmIPDiagnostic(group),
      };
    }
  }

  return {success: true, value: {...value, devices} as unknown as HmIPState};
}

export function parseHmIPStateChange(value: unknown): HmIPParseResult<HmIPStateChange> {
  if (!isHmIPRecord(value) || !isHmIPRecord(value.events)) {
    return {success: false, error: 'websocket payload must contain an events object'};
  }

  const events: Record<string, HmIPStateChangeEvent> = {};
  for (const [id, candidate] of Object.entries(value.events)) {
    if (!isHmIPRecord(candidate) || typeof candidate.pushEventType !== 'string') {
      return {
        success: false,
        error: 'event at key [REDACTED]: pushEventType must be a string',
        diagnostic: formatHmIPDiagnostic(candidate),
      };
    }

    switch (candidate.pushEventType) {
      case 'GROUP_CHANGED':
      case 'GROUP_ADDED':
      case 'GROUP_REMOVED':
        {
          const error = getHmIPGroupValidationError(candidate.group);
          if (error) {
            return {
              success: false,
              error: `event at key [REDACTED]: ${candidate.pushEventType}.group is invalid: ${error}`,
              diagnostic: formatHmIPDiagnostic(candidate.group),
            };
          }
        }
        events[id] = {pushEventType: candidate.pushEventType, group: candidate.group as HmIPGroup};
        break;
      case 'DEVICE_ADDED':
      case 'DEVICE_CHANGED':
        {
          const error = getHmIPDeviceValidationError(candidate.device);
          if (error) {
            return {
              success: false,
              error: `event at key [REDACTED]: ${candidate.pushEventType}.device is invalid: ${error}`,
              diagnostic: formatHmIPDiagnostic(candidate.device),
            };
          }
          events[id] = {
            pushEventType: candidate.pushEventType,
            device: normalizeHmIPDevice(candidate.device as Record<string, unknown>),
          };
        }
        break;
      case 'DEVICE_REMOVED':
        if (!isHmIPRecord(candidate.device)
          || typeof candidate.device.id !== 'string'
          || (candidate.device.modelType != null && typeof candidate.device.modelType !== 'string')) {
          return {
            success: false,
            error: 'event at key [REDACTED]: DEVICE_REMOVED.device is invalid',
            diagnostic: formatHmIPDiagnostic(candidate.device),
          };
        }
        events[id] = {
          pushEventType: candidate.pushEventType,
          device: {id: candidate.device.id, modelType: candidate.device.modelType ?? ''},
        };
        break;
      case 'DEVICE_CHANNEL_EVENT':
        if (typeof candidate.deviceId !== 'string'
          || (candidate.channelIndex != null && typeof candidate.channelIndex !== 'number')
          || (candidate.channelEventType != null && typeof candidate.channelEventType !== 'string')) {
          return {
            success: false,
            error: 'event at key [REDACTED]: DEVICE_CHANNEL_EVENT fields are invalid',
            diagnostic: formatHmIPDiagnostic(candidate),
          };
        }
        events[id] = {
          pushEventType: candidate.pushEventType,
          deviceId: candidate.deviceId,
          channelIndex: candidate.channelIndex ?? 1,
          channelEventType: candidate.channelEventType ?? '',
        };
        break;
      case 'HOME_CHANGED':
        {
          const error = getHmIPHomeValidationError(candidate.home);
          if (error) {
            return {
              success: false,
              error: `event at key [REDACTED]: HOME_CHANGED.home is invalid: ${error}`,
              diagnostic: formatHmIPDiagnostic(candidate.home),
            };
          }
        }
        events[id] = {pushEventType: candidate.pushEventType, home: candidate.home as HmIPHome};
        break;
      case 'SECURITY_JOURNAL_CHANGED':
        events[id] = {pushEventType: candidate.pushEventType, data: candidate};
        break;
      default:
        events[id] = {
          pushEventType: 'UNKNOWN',
          sourcePushEventType: candidate.pushEventType,
          data: candidate,
        };
    }
  }

  return {success: true, value: {events}};
}

export function isHmIPStateChange(value: unknown): boolean {
  return parseHmIPStateChange(value).success;
}
