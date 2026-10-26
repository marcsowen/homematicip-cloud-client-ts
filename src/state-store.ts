import {type HmIPDevice, type HmIPState, type HmIPStateChange, isHmIPRecord} from "./state.js";

/** Merge cloud state without mutating the previous snapshot or treating button presses as state. */
export function reduceHmIPState(state: HmIPState, change: HmIPStateChange): HmIPState {
    const next = {...state, devices: {...state.devices}, groups: {...state.groups}};
    for (const event of Object.values(change.events)) {
        switch (event.pushEventType) {
            case "DEVICE_ADDED":
            case "DEVICE_CHANGED":
                next.devices[event.device.id] = event.device;
                break;
            case "DEVICE_REMOVED":
                delete next.devices[event.device.id];
                break;
            case "GROUP_ADDED":
            case "GROUP_CHANGED":
                next.groups[event.group.id] = event.group;
                break;
            case "GROUP_REMOVED":
                delete next.groups[event.group.id];
                break;
            case "HOME_CHANGED":
                next.home = event.home;
                break;
        }
    }
    return next;
}

export function freezeHmIPState<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            freezeHmIPState(child);
        }
        Object.freeze(value);
    }
    return value;
}

/** Unknown reachability is not silently classified as a radio fault. */
export function getHmIPDeviceReachability(device: HmIPDevice): boolean | undefined {
    let known = false;
    for (const channel of Object.values(device.functionalChannels)) {
        if (!isHmIPRecord(channel) || typeof channel.unreach !== "boolean") {
            continue;
        }
        if (channel.unreach) {
            return false;
        }
        known = true;
    }
    return known ? true : undefined;
}
