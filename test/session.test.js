import assert from "node:assert/strict";
import test from "node:test";
import {setImmediate as tick} from "node:timers/promises";
import {getHmIPDeviceReachability, HmIPClientError, HmIPSession, reduceHmIPState} from "../dist/index.js";

const snapshot = () => ({devices: {}, groups: {}, home: {id: "home", functionalHomes: {}}});
const change = (...events) => ({events: Object.fromEntries(events.map((e, i) => [i, e]))});
const button = {
    pushEventType: "DEVICE_CHANNEL_EVENT",
    deviceId: "button",
    channelIndex: 1,
    channelEventType: "KEY_PRESS_SHORT",
};
async function harness(t, options = {}) {
    const requests = [],
        states = [],
        changes = [],
        statuses = [],
        errors = [];
    let connection, receive;
    const transport = {
        async init() {},
        disconnect() {},
        connect(onChange, onConnection) {
            receive = onChange;
            connection = onConnection;
            onConnection("connected");
        },
        getCurrentState(signal) {
            return new Promise((resolve, reject) => requests.push({signal, resolve, reject}));
        },
    };
    const session = new HmIPSession(
        transport,
        {
            snapshot: (s) => {
                states.push(s);
            },
            change: (c, s) => {
                changes.push([c, s]);
            },
            status: (s) => {
                statuses.push(s);
            },
            error: (e) => {
                errors.push(e);
            },
        },
        {retryMillis: 100, ...options},
    );
    const started = session.start();
    t.after(() => session.stop());
    await tick();
    return {
        session,
        transport,
        requests,
        states,
        changes,
        statuses,
        errors,
        started,
        connection: (e) => connection(e),
        receive: (e) => receive(e),
    };
}

test("snapshot merges device/group/home events before readiness; presses delivered once; state is immutable", async (t) => {
    const h = await harness(t);
    const old = snapshot();
    old.devices.removed = {id: "removed"};
    old.groups.removed = {id: "removed"};
    h.receive(
        change(
            {pushEventType: "DEVICE_REMOVED", device: {id: "removed"}},
            {pushEventType: "DEVICE_ADDED", device: {id: "new", label: "new"}},
            {pushEventType: "GROUP_REMOVED", group: {id: "removed"}},
            {pushEventType: "GROUP_CHANGED", group: {id: "heating", type: "HEATING"}},
            {pushEventType: "HOME_CHANGED", home: {id: "updated"}},
            button,
        ),
    );
    h.requests[0].resolve(old);
    await h.started;
    assert.deepEqual(Object.keys(h.states[0].devices), ["new"]);
    assert.deepEqual(Object.keys(h.states[0].groups), ["heating"]);
    assert.equal(h.states[0].home.id, "updated");
    assert.equal(h.session.status, "ready");
    assert.deepEqual(Object.values(h.changes[0][0].events), [button]);
    assert.throws(() => {
        h.states[0].devices.new.label = "mutation";
    }, TypeError);
    h.receive(change({pushEventType: "DEVICE_CHANGED", device: {id: "new", label: "later"}}));
    await h.session.whenIdle();
    assert.equal(h.changes.at(-1)[1].devices.new.label, "later");
    assert.equal(h.states[0].devices.new.label, "new");
});

test("disconnect aborts old snapshots and a late response cannot overwrite a newer generation", async (t) => {
    const h = await harness(t);
    h.connection("disconnected");
    assert.equal(h.requests[0].signal.aborted, true);
    h.connection("reconnected");
    const current = snapshot();
    current.home.id = "current";
    h.requests[1].resolve(current);
    await tick();
    h.requests[0].resolve(snapshot());
    await h.started;
    await h.session.whenIdle();
    assert.equal(h.states.length, 1);
    assert.equal(h.states[0].home.id, "current");
    assert.equal(h.session.status, "ready");
});

test("failed snapshots retry, preserve buffered presses and never periodically poll after recovery", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const h = await harness(t);
    h.receive(change(button));
    h.requests[0].reject(new HmIPClientError("timeout", "home/getCurrentState"));
    await h.started;
    assert.notEqual(h.session.status, "ready");
    h.receive(change({...button, channelIndex: 2}));
    t.mock.timers.tick(100);
    h.requests[1].resolve(snapshot());
    await h.session.whenIdle();
    assert.equal(h.session.status, "ready");
    assert.equal(h.changes.length, 2);
    assert.deepEqual(Object.values(h.changes[0][0].events), [button]);
    assert.equal(Object.values(h.changes[1][0].events)[0].channelIndex, 2);
    t.mock.timers.tick(600000);
    await h.session.whenIdle();
    assert.equal(h.requests.length, 2);
});

test("shutdown cancels outstanding work and ignores late events and reconnects", async (t) => {
    const h = await harness(t);
    await h.session.stop();
    h.requests[0].resolve(snapshot());
    h.connection("reconnected");
    h.receive(change(button));
    await h.started;
    assert.equal(h.requests[0].signal.aborted, true);
    assert.deepEqual(h.states, []);
    assert.deepEqual(h.changes, []);
    assert.equal(h.session.status, "stopped");
});

test("initialization failures retry and stop cancels the retry timer", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    let initCalls = 0;
    const session = new HmIPSession(
        {
            async init() {
                initCalls++;
                throw new HmIPClientError("network", "lookup/getHost");
            },
            connect() {
                assert.fail("must not connect");
            },
            disconnect() {},
            getCurrentState() {
                assert.fail("must not fetch");
            },
        },
        {snapshot() {}, change() {}, status() {}, error() {}},
        {retryMillis: 100},
    );
    await session.start();
    assert.equal(initCalls, 1);
    t.mock.timers.tick(100);
    await session.whenIdle();
    assert.equal(initCalls, 2);
    await session.stop();
    t.mock.timers.tick(1000);
    assert.equal(initCalls, 2);
});

test("buffer overflow aborts and resynchronizes rather than publishing incomplete state", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const h = await harness(t, {maxBufferedEvents: 1});
    h.receive(change(button, button));
    assert.equal(h.errors[0].kind, "event-buffer-full");
    assert.equal(h.requests[0].signal.aborted, true);
    h.requests[0].resolve(snapshot());
    await h.started;
    assert.deepEqual(h.states, []);
    t.mock.timers.tick(100);
    h.requests[1].resolve(snapshot());
    await h.session.whenIdle();
    assert.equal(h.session.status, "ready");
});

test("transport-connected is not ready until the async snapshot observer finishes", async () => {
    let finish;
    const session = new HmIPSession(
        {
            async init() {},
            disconnect() {},
            connect(_c, connected) {
                connected("connected");
            },
            async getCurrentState() {
                return snapshot();
            },
        },
        {
            snapshot: () =>
                new Promise((r) => {
                    finish = r;
                }),
            change() {},
            status() {},
            error() {},
        },
    );
    const start = session.start();
    await tick();
    assert.notEqual(session.status, "ready");
    // Status callbacks are ordered after the snapshot, including asynchronous adapter updates.
    finish();
    await start;
    assert.equal(session.status, "ready");
    await session.stop();
});

test("pure reducer preserves the input; reachability examines all channels and preserves unknown", () => {
    const state = snapshot();
    const next = reduceHmIPState(state, change({pushEventType: "DEVICE_ADDED", device: {id: "new"}}));
    assert.deepEqual(state.devices, {});
    assert.ok(next.devices.new);
    assert.equal(getHmIPDeviceReachability({functionalChannels: {}}), undefined);
    assert.equal(getHmIPDeviceReachability({functionalChannels: {0: {lowBat: false}, 1: {unreach: true}}}), false);
    assert.equal(getHmIPDeviceReachability({functionalChannels: {0: {unreach: false}}}), true);
});

test("an asynchronous adapter failure does not announce readiness and retries a fresh snapshot", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    let applied = 0,
        ready = 0;
    const errors = [];
    const session = new HmIPSession(
        {
            async init() {},
            disconnect() {},
            connect(_c, status) {
                status("connected");
            },
            async getCurrentState() {
                return snapshot();
            },
        },
        {
            async snapshot() {
                if (++applied === 1) {
                    throw new Error("private payload");
                }
            },
            change() {},
            status(s) {
                if (s === "ready") {
                    ready++;
                }
            },
            error(e) {
                errors.push(e);
            },
        },
        {retryMillis: 100},
    );
    await session.start();
    assert.equal(ready, 0);
    assert.notEqual(session.status, "ready");
    assert.equal(errors[0].path, "session/observer");
    assert.ok(!errors[0].message.includes("private"));
    t.mock.timers.tick(100);
    await session.whenIdle();
    assert.equal(ready, 1);
    assert.equal(applied, 2);
    await session.stop();
});
