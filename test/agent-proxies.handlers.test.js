import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../lib/agent-proxies.js";
import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";

// One fully-enabled agent, unless a test overrides it. context.config() returns
// the RAW yaml; loadAiReviewConfig normalizes it.
function agentConfig(overrides = {}) {
  return {
    agents: [
      {
        name: "dusty",
        bot: "dusty-the-robot[bot]",
        mention: "@dusty\\b",
        checks: "^buildkite/",
        events: ["review", "comment", "check", "mention"],
        ignore_users: ["healthengine-sre"],
        debounce_seconds: 45,
        dispatch: { owner: "acme", repo: "dusty", workflow: "webhook_event.yml", ref: "main" },
        ...overrides,
      },
    ],
  };
}

function dispatches(octokit) {
  return octokit.calls.filter((c) => c.method === "rest.actions.createWorkflowDispatch");
}

// Dispatch a synthetic webhook, then run out the debounce timer and let the
// async dispatch settle.
async function fire(t, { event, payload, config = agentConfig(), octokit }) {
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
  } catch {
    // already enabled earlier in the same test
  }
  const { app, dispatch } = makeApp();
  register(app);
  await dispatch(event, makeContext({ octokit, config, payload }));
  t.mock.timers.tick(46_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// pull_request_review.submitted
// ---------------------------------------------------------------------------

test("review on a Dusty PR dispatches with the review author as actor", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "pull_request_review.submitted",
    octokit,
    payload: {
      repository: { name: "svc" },
      pull_request: { number: 11, user: { login: "dusty-the-robot[bot]" } },
      review: { user: { login: "david", type: "User" }, state: "changes_requested", body: "please fix" },
    },
  });
  const calls = dispatches(octokit);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, {
    owner: "acme",
    repo: "dusty",
    workflow_id: "webhook_event.yml",
    ref: "main",
    inputs: { event: "review", repo: "svc", pr: "11", actor: "david", body: "please fix" },
  });
});

test("an approval does not dispatch", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "pull_request_review.submitted",
    octokit,
    payload: {
      repository: { name: "svc" },
      pull_request: { number: 11, user: { login: "dusty-the-robot[bot]" } },
      review: { user: { login: "david", type: "User" }, state: "approved", body: "" },
    },
  });
  assert.equal(dispatches(octokit).length, 0);
});

// ---------------------------------------------------------------------------
// issue_comment.created
// ---------------------------------------------------------------------------

test("human comment on a Dusty PR dispatches a comment event", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "issue_comment.created",
    octokit,
    payload: {
      repository: { name: "svc" },
      issue: { number: 12, pull_request: {}, user: { login: "dusty-the-robot[bot]" } },
      comment: { user: { login: "david", type: "User" }, body: "nit here" },
    },
  });
  const calls = dispatches(octokit);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.inputs.event, "comment");
  assert.equal(calls[0].args.inputs.pr, "12");
});

test("@mention on a foreign PR dispatches a mention event", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "issue_comment.created",
    octokit,
    payload: {
      repository: { name: "svc" },
      issue: { number: 13, pull_request: {}, user: { login: "someone-else" } },
      comment: { user: { login: "david", type: "User" }, body: "cc @dusty" },
    },
  });
  const calls = dispatches(octokit);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.inputs.event, "mention");
});

test("bot comments are ignored", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "issue_comment.created",
    octokit,
    payload: {
      repository: { name: "svc" },
      issue: { number: 14, pull_request: {}, user: { login: "dusty-the-robot[bot]" } },
      comment: { user: { login: "screenshot[bot]", type: "Bot" }, body: "here is a screenshot @dusty" },
    },
  });
  assert.equal(dispatches(octokit).length, 0);
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test("a failing buildkite status on a Dusty PR dispatches a check event", async (t) => {
  const octokit = makeOctokit({
    "rest.repos.listPullRequestsAssociatedWithCommit": {
      data: [
        { number: 20, state: "open", user: { login: "dusty-the-robot[bot]" } },
        { number: 21, state: "open", user: { login: "someone-else" } },
      ],
    },
  });
  await fire(t, {
    event: "status",
    octokit,
    payload: {
      repository: { name: "svc" },
      state: "failure",
      context: "buildkite/test",
      sha: "deadbeef",
      sender: { login: "buildkite[bot]" },
    },
  });
  const calls = dispatches(octokit);
  assert.equal(calls.length, 1); // only the Dusty-owned PR
  assert.deepEqual(calls[0].args.inputs, {
    event: "check", repo: "svc", pr: "20", actor: "buildkite[bot]", body: "failure: buildkite/test",
  });
});

test("a pending status never looks up PRs", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "status",
    octokit,
    payload: {
      repository: { name: "svc" },
      state: "pending",
      context: "buildkite/test",
      sha: "deadbeef",
    },
  });
  assert.equal(octokit.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Dormant when unconfigured
// ---------------------------------------------------------------------------

test("no agents configured → nothing dispatches", async (t) => {
  const octokit = makeOctokit();
  await fire(t, {
    event: "pull_request_review.submitted",
    config: {},
    octokit,
    payload: {
      repository: { name: "svc" },
      pull_request: { number: 11, user: { login: "dusty-the-robot[bot]" } },
      review: { user: { login: "david", type: "User" }, state: "changes_requested", body: "x" },
    },
  });
  assert.equal(octokit.calls.length, 0);
});
