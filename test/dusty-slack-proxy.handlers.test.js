import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import { register } from "../lib/dusty-slack-proxy.js";

const SECRET = "shhh";

// Minimal stand-ins for Probot's (app, { getRouter }) contract: getRouter is a
// FUNCTION IN THE SECOND ARG, not a method on app. Registering against a bare
// `app` must not throw — that mistake only surfaces at boot in production.
function makeHarness({ getRouter = true } = {}) {
  const routes = [];
  const warnings = [];
  const app = { log: { warn: (m) => warnings.push(m) } };
  const router = { post: (path, ...handlers) => routes.push({ path, handlers }) };
  const options = getRouter ? { getRouter: () => router } : {};
  return { app, options, routes, warnings };
}

// Drive a registered route the way express would: middleware chain, then handler.
async function post({ routes, headers = {}, body }) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Object.assign(new EventEmitter(), { headers, method: "POST" });
  let statusCode; let sent; let json;
  const res = {
    status(code) { statusCode = code; return res; },
    send(payload) { sent = payload ?? ""; return res; },
    json(payload) { json = payload; return res; },
  };
  const { handlers } = routes.find((r) => r.path === "/slack/events");
  const run = (i) => (i >= handlers.length ? undefined : handlers[i](req, res, () => run(i + 1)));
  const pending = run(0);
  req.emit("data", Buffer.from(raw));
  req.emit("end");
  await pending;
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { statusCode, sent, json };
}

function signedHeaders(raw, secret = SECRET) {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature":
      "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex"),
  };
}

test("register mounts /slack/events via the getRouter option", () => {
  const h = makeHarness();
  register(h.app, h.options);
  assert.equal(h.routes.length, 1);
  assert.equal(h.routes[0].path, "/slack/events");
});

test("register no-ops (no throw) when getRouter is unavailable", () => {
  const h = makeHarness({ getRouter: false });
  assert.doesNotThrow(() => register(h.app, h.options));
  assert.equal(h.routes.length, 0);
  assert.equal(h.warnings.length, 1);
});

test("register tolerates being called with no options at all", () => {
  assert.doesNotThrow(() => register({}));
});

test("answers the url_verification challenge", async () => {
  const h = makeHarness();
  register(h.app, h.options);
  const body = { type: "url_verification", challenge: "abc123" };
  const res = await post({ routes: h.routes, body });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json, { challenge: "abc123" });
});

test("rejects an unsigned event_callback with 401", async () => {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  const h = makeHarness();
  register(h.app, h.options);
  const res = await post({ routes: h.routes, body: { type: "event_callback" } });
  assert.equal(res.statusCode, 401);
});

test("acks a correctly signed event_callback with 200", async () => {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  const h = makeHarness();
  register(h.app, h.options);
  const raw = JSON.stringify({ type: "event_callback", event_id: "Ev1", event: { type: "app_mention" } });
  const res = await post({ routes: h.routes, headers: signedHeaders(raw), body: raw });
  assert.equal(res.statusCode, 200);
});
