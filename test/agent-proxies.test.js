import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { normalizeAgents } from "../lib/config.js";
import {
  classifyReview,
  classifyComment,
  classifyStatus,
} from "../lib/agent-proxies.js";

// normalizeAgents warns on malformed entries; silence the expected noise.
let originalWarn;
beforeEach(() => {
  originalWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = originalWarn;
});

const RAW = {
  name: "dusty",
  bot: "dusty-the-robot[bot]",
  mention: "@dusty\\b",
  checks: "^buildkite/",
  events: ["review", "comment", "check", "mention"],
  ignore_users: ["healthengine-sre"],
  debounce_seconds: 45,
  dispatch: { owner: "acme", repo: "dusty", workflow: "webhook_event.yml", ref: "main" },
};

// A fully-configured agent for the classifier cases.
const agent = () => normalizeAgents([RAW])[0];

// ---------------------------------------------------------------------------
// normalizeAgents
// ---------------------------------------------------------------------------

test("normalizeAgents: [] for non-arrays or empty", () => {
  assert.deepEqual(normalizeAgents(undefined), []);
  assert.deepEqual(normalizeAgents(null), []);
  assert.deepEqual(normalizeAgents("dusty"), []);
  assert.deepEqual(normalizeAgents([]), []);
});

test("normalizeAgents: drops entries missing name, bot, or dispatch.{owner,repo}", () => {
  assert.equal(normalizeAgents([{ bot: "x[bot]", dispatch: RAW.dispatch }]).length, 0);
  assert.equal(normalizeAgents([{ name: "x", dispatch: RAW.dispatch }]).length, 0);
  assert.equal(normalizeAgents([{ name: "x", bot: "x[bot]" }]).length, 0);
  assert.equal(
    normalizeAgents([{ name: "x", bot: "x[bot]", dispatch: { owner: "a" } }]).length,
    0,
  );
});

test("normalizeAgents: dispatch workflow and ref default to webhook_event.yml @ main", () => {
  const a = normalizeAgents([{ ...RAW, dispatch: { owner: "acme", repo: "dusty" } }])[0];
  assert.equal(a.dispatch.workflow, "webhook_event.yml");
  assert.equal(a.dispatch.ref, "main");
});

test("normalizeAgents: compiles a valid agent with defaults", () => {
  const a = agent();
  assert.equal(a.name, "dusty");
  assert.equal(a.botLower, "dusty-the-robot[bot]");
  assert.deepEqual([...a.events].sort(), ["check", "comment", "mention", "review"]);
  assert.ok(a.mention.test("hey @dusty please"));
  assert.equal(a.mention.test("@dustybin"), false);
  assert.ok(a.checks.test("buildkite/lint"));
  assert.ok(a.ignoreUsers.has("healthengine-sre"));
  assert.equal(a.debounceMs, 45_000);
  assert.equal(a.dispatch.ref, "main");
});

test("normalizeAgents: events default to all four when absent", () => {
  const a = normalizeAgents([{ ...RAW, events: undefined }])[0];
  assert.deepEqual([...a.events].sort(), ["check", "comment", "mention", "review"]);
});

test("normalizeAgents: an invalid mention/checks regex disables just that capability", () => {
  const a = normalizeAgents([{ ...RAW, mention: "(", checks: "[" }])[0];
  assert.equal(a.mention, null);
  assert.equal(a.checks, null);
  assert.equal(a.events.has("mention"), false);
  assert.equal(a.events.has("check"), false);
  // The IO-backed events survive.
  assert.ok(a.events.has("review"));
  assert.ok(a.events.has("comment"));
});

test("normalizeAgents: an agent whose only events lose their matchers is dropped", () => {
  assert.equal(
    normalizeAgents([{ ...RAW, events: ["mention"], mention: "(" }]).length,
    0,
  );
});

test("normalizeAgents: debounce defaults and clamps", () => {
  assert.equal(normalizeAgents([{ ...RAW, debounce_seconds: undefined }])[0].debounceMs, 45_000);
  assert.equal(normalizeAgents([{ ...RAW, debounce_seconds: "45" }])[0].debounceMs, 45_000);
  assert.equal(normalizeAgents([{ ...RAW, debounce_seconds: 9999 }])[0].debounceMs, 300_000);
  assert.equal(normalizeAgents([{ ...RAW, debounce_seconds: 0 }])[0].debounceMs, 0);
});

test("normalizeAgents: ignore_users are lower-cased and de-junked", () => {
  const a = normalizeAgents([{ ...RAW, ignore_users: ["  Healthengine-SRE ", 42, ""] }])[0];
  assert.deepEqual([...a.ignoreUsers], ["healthengine-sre"]);
});

// ---------------------------------------------------------------------------
// classifyReview
// ---------------------------------------------------------------------------

test("classifyReview: a human review on the agent's own PR forwards", () => {
  assert.equal(
    classifyReview(agent(), { prAuthor: "dusty-the-robot[bot]", reviewAuthor: "david", state: "changes_requested" }),
    "review",
  );
});

test("classifyReview: a bot reviewer (AI reviewer) still forwards", () => {
  assert.equal(
    classifyReview(agent(), { prAuthor: "dusty-the-robot[bot]", reviewAuthor: "copilot[bot]", state: "commented" }),
    "review",
  );
});

test("classifyReview: the agent's own review, approvals, and other PRs are ignored", () => {
  const a = agent();
  assert.equal(classifyReview(a, { prAuthor: "dusty-the-robot[bot]", reviewAuthor: "Dusty-The-Robot[bot]", state: "commented" }), null);
  assert.equal(classifyReview(a, { prAuthor: "dusty-the-robot[bot]", reviewAuthor: "david", state: "approved" }), null);
  assert.equal(classifyReview(a, { prAuthor: "someone-else", reviewAuthor: "david", state: "changes_requested" }), null);
});

test("classifyReview: null when review events are disabled", () => {
  const a = normalizeAgents([{ ...RAW, events: ["comment"] }])[0];
  assert.equal(classifyReview(a, { prAuthor: "dusty-the-robot[bot]", reviewAuthor: "david", state: "changes_requested" }), null);
});

// ---------------------------------------------------------------------------
// classifyComment
// ---------------------------------------------------------------------------

test("classifyComment: a human comment on the agent's own PR is feedback", () => {
  assert.equal(
    classifyComment(agent(), { prAuthor: "dusty-the-robot[bot]", commentAuthor: "david", isBot: false, body: "nit" }),
    "comment",
  );
});

test("classifyComment: an @mention on someone else's PR is a mention", () => {
  assert.equal(
    classifyComment(agent(), { prAuthor: "someone-else", commentAuthor: "david", isBot: false, body: "hey @dusty look" }),
    "mention",
  );
});

test("classifyComment: bots, ignore_users, the agent itself, and unmentioned foreign PRs are ignored", () => {
  const a = agent();
  assert.equal(classifyComment(a, { prAuthor: "someone-else", commentAuthor: "screenshot[bot]", isBot: true, body: "@dusty" }), null);
  assert.equal(classifyComment(a, { prAuthor: "dusty-the-robot[bot]", commentAuthor: "healthengine-sre", isBot: false, body: "auto" }), null);
  assert.equal(classifyComment(a, { prAuthor: "dusty-the-robot[bot]", commentAuthor: "dusty-the-robot[bot]", isBot: true, body: "self" }), null);
  assert.equal(classifyComment(a, { prAuthor: "someone-else", commentAuthor: "david", isBot: false, body: "no mention here" }), null);
});

// ---------------------------------------------------------------------------
// classifyStatus
// ---------------------------------------------------------------------------

test("classifyStatus: a settled watched context forwards as a check", () => {
  const a = agent();
  assert.equal(classifyStatus(a, { state: "failure", context: "buildkite/test" }), "check");
  assert.equal(classifyStatus(a, { state: "error", context: "buildkite/deploy" }), "check");
  assert.equal(classifyStatus(a, { state: "success", context: "buildkite/test" }), "check");
});

test("classifyStatus: pending states or unwatched contexts are ignored", () => {
  const a = agent();
  assert.equal(classifyStatus(a, { state: "pending", context: "buildkite/test" }), null);
  assert.equal(classifyStatus(a, { state: "failure", context: "netlify/deploy-preview" }), null);
});

test("classifyStatus: null when check events are disabled", () => {
  const a = normalizeAgents([{ ...RAW, events: ["review"] }])[0];
  assert.equal(classifyStatus(a, { state: "failure", context: "buildkite/test" }), null);
});
