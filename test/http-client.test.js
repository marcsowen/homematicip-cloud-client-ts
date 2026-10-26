import assert from "node:assert/strict";
import test from "node:test";
import {HmIPHttpClient} from "../dist/http-client.js";

const log = {debug() {}, error() {}, info() {}, warn() {}};
const credentials = {
    accessPointId: "30141234",
    authToken: "auth-token",
    clientAuthToken: "client-token",
    pin: "1234",
};

test("sends authenticated JSON requests", async () => {
    const requests = [];
    const client = new HmIPHttpClient(log, new URL("https://rest.example/"), credentials, {
        fetch: async (url, options) => {
            requests.push({options, url});
            return new Response(JSON.stringify({success: true}), {
                headers: {"content-type": "application/json"},
                status: 200,
            });
        },
    });

    assert.deepEqual(await client.request("device/control", {on: true}), {ok: true, body: {success: true}});
    assert.deepEqual(await client.request("auth/request", undefined, {authenticated: false}), {
        ok: true,
        body: {success: true},
    });
    assert.equal(requests[0].url, "https://rest.example/hmip/device/control");
    assert.equal(requests[0].options.headers.AUTHTOKEN, "auth-token");
    assert.equal(requests[0].options.headers.CLIENTAUTH, "client-token");
    assert.equal(requests[0].options.headers["ACCESSPOINT-ID"], "30141234");
    assert.equal(requests[0].options.headers.PIN, "1234");
    assert.equal(requests[0].options.body, JSON.stringify({on: true}));
    assert.equal("AUTHTOKEN" in requests[1].options.headers, false);
    client.shutdown();
});

test("classifies malformed JSON and HTTP failures", async () => {
    const responses = [
        new Response("{invalid", {headers: {"content-type": "application/json"}, status: 200}),
        new Response(undefined, {status: 503, statusText: "Unavailable"}),
    ];
    const client = new HmIPHttpClient(log, new URL("https://rest.example"), credentials, {
        fetch: async () => responses.shift(),
    });

    assert.equal((await client.request("invalid-json")).error.kind, "invalid-json");
    assert.deepEqual(await client.request("unavailable"), {
        ok: false,
        error: {kind: "http", message: "HTTP 503 Unavailable", path: "unavailable", status: 503},
    });
    client.shutdown();
});

test("shutdown aborts an active request", async () => {
    let requestStarted;
    const started = new Promise((resolve) => {
        requestStarted = resolve;
    });
    const client = new HmIPHttpClient(log, new URL("https://rest.example"), credentials, {
        fetch: async (_url, options) => {
            requestStarted();
            return new Promise((_resolve, reject) => {
                options.signal.addEventListener("abort", () => reject(options.signal.reason), {once: true});
            });
        },
    });

    const request = client.request("long-running");
    await started;
    client.shutdown();
    assert.equal((await request).error.kind, "aborted");
    assert.equal((await client.request("after-shutdown")).error.kind, "aborted");
});

test("debug logs omit response bodies without changing returned data", async () => {
    const messages = [];
    const body = {authToken: "secret-token", nested: {pin: "secret-pin", label: "private-room"}};
    const client = new HmIPHttpClient(
        {...log, debug: (...args) => messages.push(args)},
        new URL("https://rest.example/"),
        credentials,
        {
            fetch: async () => new Response(JSON.stringify(body), {headers: {"content-type": "application/json"}}),
        },
    );
    try {
        assert.deepEqual((await client.request("auth/requestAuthToken")).body, body);
        const output = JSON.stringify(messages);
        for (const secret of ["secret-token", "secret-pin", "private-room"]) {
            assert.equal(output.includes(secret), false);
        }
        assert.ok(output.includes("JSON body omitted"));
    } finally {
        client.shutdown();
    }
});

test("malformed JSON errors do not disclose response fragments", async () => {
    const messages = [];
    const client = new HmIPHttpClient(
        {...log, error: (...args) => messages.push(args)},
        new URL("https://rest.example/"),
        credentials,
        {
            fetch: async () => new Response("secret-token-not-json", {headers: {"content-type": "application/json"}}),
        },
    );
    try {
        const result = await client.request("auth/requestAuthToken");
        assert.equal(result.error.kind, "invalid-json");
        assert.equal(JSON.stringify([result, messages]).includes("secret-token-not-json"), false);
    } finally {
        client.shutdown();
    }
});
