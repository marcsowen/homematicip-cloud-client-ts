export interface HmIPRequestOptions {
  signal?: AbortSignal;
  /** Smaller numbers run first; default is 5. */
  priority?: number;
}
export interface HmIPDeviceCommandBodies {
  setSwitchState: {on: boolean};
  setDimLevel: {dimLevel: number};
  setShutterLevel: {shutterLevel: number};
  setPrimaryShadingLevel: {primaryShadingLevel: number};
  setSlatsLevel: {slatsLevel: number; shutterLevel?: number};
  stop: Record<never, never>;
  startImpulse: Record<never, never>;
  setLockState: {targetLockState: string; authorizationPin: string};
  sendDoorCommand: {doorCommand: string};
  setWateringSwitchState: {wateringActive: boolean};
  setWateringSwitchStateWithTime: {wateringActive: boolean; wateringTime: number};
  setWaterSupplyState: {waterSupplyState: string};
  setHueSaturationDimLevel: {hue: number; saturationLevel: number; dimLevel: number};
  setColorTemperatureDimLevel: {colorTemperature: number; dimLevel: number};
  setSimpleRGBColorDimLevel: {simpleRGBColorState: string; dimLevel: number};
  setOpticalSignal: {simpleRGBColorState: string; dimLevel: number; opticalSignalBehaviour: string};
}
export interface HmIPDeviceAddress {deviceId: string; channelIndex: number}
export type HmIPCommandBodies = {
  [K in keyof HmIPDeviceCommandBodies]: HmIPDeviceAddress & HmIPDeviceCommandBodies[K]
} & {
  setHeatingControlMode: {groupId: string; controlMode: string};
  setHeatingSetPointTemperature: {groupId: string; setPointTemperature: number};
  setSecurityZonesActivation: {zonesActivation: Record<string, boolean>};
};
export type HmIPCommand = <K extends keyof HmIPCommandBodies>(
  operation: K, body: HmIPCommandBodies[NoInfer<K>], options?: HmIPRequestOptions,
) => Promise<void>;
export type HmIPDeviceCommand = <K extends keyof HmIPDeviceCommandBodies>(
  operation: K, address: HmIPDeviceAddress, body: HmIPDeviceCommandBodies[NoInfer<K>], options?: HmIPRequestOptions,
) => Promise<void>;
