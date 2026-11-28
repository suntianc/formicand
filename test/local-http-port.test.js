import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { listenOnFixtureHttpPort } from "./fixtures/http-server.mjs";
import { listenOnLocalHttpPort } from "../dist/src/platform/local-http-port.js";

test("an OS address rejected by Fetch is replaced before the HTTP URL is published", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.method);
    response.writeHead(401).end();
  });
  t.after(() => new Promise((done) => server.close(done)));
  const address = server.address.bind(server);
  let reported = 0;
  t.mock.method(server, "address", () => {
    const actual = address();
    // Node rejects 6697 before connecting, independent of which process holds that port.
    return ++reported === 1 ? { ...actual, port: 6697 } : actual;
  });
  const port = await listenOnLocalHttpPort(server);
  assert.ok(reported >= 2);
  assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 401);
  assert.deepEqual(requests, ["HEAD", "GET"]);
});

test("persistent unusable addresses stop retrying and leave no listener", async (t) => {
  const server = createServer();
  t.mock.method(server, "address", () => ({ port: 6697 }));
  await assert.rejects(listenOnLocalHttpPort(server), /fetch-accessible/);
  assert.equal(server.listening, false);
});

test("an HTTP bind error reaches the caller", async (t) => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  await assert.rejects(listenOnLocalHttpPort(server), { code: "ERR_SERVER_ALREADY_LISTEN" });
});

test("a fixture retries a lost port without sending HTTP probes to its handler", async (t) => {
  const held = createServer();
  held.listen(0, "127.0.0.1");
  await once(held, "listening");
  t.after(() => new Promise((done) => held.close(done)));
  const requests = [];
  const fixture = createServer((request, response) => {
    requests.push(request.method);
    response.end("fixture");
  });
  t.after(() => new Promise((done) => fixture.close(done)));
  const listen = fixture.listen.bind(fixture);
  const attempts = t.mock.method(fixture, "listen", (port, host) =>
    listen(attempts.mock.callCount() === 0 ? held.address().port : port, host)
  );
  const port = await listenOnFixtureHttpPort(fixture);
  assert.ok(attempts.mock.callCount() >= 2);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "fixture");
  assert.deepEqual(requests, ["GET"]);
});
