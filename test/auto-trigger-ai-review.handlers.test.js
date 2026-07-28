import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "../lib/auto-trigger-ai-review.js";
import { makeApp, makeOctokit, makeContext } from "./helpers/mock-github.js";

// The handlers build their own config via loadAiReviewConfig(context), which
// reads the RAW YAML from context.config(). Only enabling copilot makes
// triggerRandomReviewer deterministic (and timer-free) in the happy paths.
// Automatic invites are opted into by default here — the opt-in default
// itself is covered explicitly below.
function fakeConfig({ providers = ["copilot"], ai_review } = {}) {
  return { providers, ai_review: { automatic: true, ...ai_review } };
}

function makePayload(overrides = {}) {
  return {
    pull_request: {
      number: 11,
      draft: false,
      state: "open",
      base: { ref: "main" },
      head: { sha: "abc123" },
      user: { login: "david", type: "User" },
      labels: [],
      additions: 10,
      deletions: 5,
      requested_reviewers: [],
      requested_teams: [],
      ...overrides,
    },
  };
}

function countCalls(octokit, method) {
  return octokit.calls.filter((c) => c.method === method).length;
}

// Eligible PRs are evaluated behind a ~30s timer (so gitStream's status can
// land first). Advance the mocked clock and let the async chain settle.
async function flushEvaluateDelay(t) {
  t.mock.timers.tick(31_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function dispatchAutoTrigger(t, { event = "pull_request.opened", payload, config, octokit, repo }) {
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
  } catch {
    // already enabled by an earlier dispatch in the same test
  }
  const { app, dispatch } = makeApp();
  register(app);
  const context = makeContext({ octokit, config, repo, payload });
  await dispatch(event, context);
  await flushEvaluateDelay(t);
}

// ---------------------------------------------------------------------------
// Cheap guards: no API traffic at all
// ---------------------------------------------------------------------------

test("auto-trigger: draft PRs are skipped by default", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig(),
    payload: makePayload({ draft: true }),
  });
  assert.equal(octokit.calls.length, 0);
});

test("auto-trigger: ai_review.include_drafts=true includes draft PRs", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig({ ai_review: { include_drafts: true } }),
    payload: makePayload({ draft: true }),
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);
});

test("auto-trigger: dependabot-authored PRs are skipped by default", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig(),
    payload: makePayload({ user: { login: "dependabot[bot]", type: "Bot" } }),
  });
  assert.equal(octokit.calls.length, 0);
});

test("auto-trigger: ai_review.skip_authors replaces the default skip list", async (t) => {
  // dependabot is no longer on the list → it gets the normal invite flow…
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig({ ai_review: { skip_authors: ["renovate[bot]"] } }),
    payload: makePayload({ user: { login: "dependabot[bot]", type: "Bot" } }),
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);

  // …while listed authors are skipped, case-insensitively.
  const skippedOctokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit: skippedOctokit,
    config: fakeConfig({ ai_review: { skip_authors: ["renovate[bot]"] } }),
    payload: makePayload({ user: { login: "Renovate[bot]", type: "Bot" } }),
  });
  assert.equal(skippedOctokit.calls.length, 0);
});

test("auto-trigger: the skip-ai-review label is respected", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig(),
    payload: makePayload({ labels: [{ name: "skip-ai-review" }] }),
  });
  assert.equal(octokit.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Config gate
// ---------------------------------------------------------------------------

test("auto-trigger: automatic invites are off unless opted in", async (t) => {
  // No ai_review section at all…
  const noConfigOctokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit: noConfigOctokit,
    config: { providers: ["copilot"] },
    payload: makePayload(),
  });
  assert.equal(noConfigOctokit.calls.length, 0);

  // …and an explicit automatic: false both stay quiet.
  const explicitOctokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit: explicitOctokit,
    config: fakeConfig({ ai_review: { automatic: false } }),
    payload: makePayload(),
  });
  assert.equal(explicitOctokit.calls.length, 0);
});

test("auto-trigger: no summonable providers means no evaluation fetches", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    // linearb is enabled but can't be summoned; the whole evaluation is moot.
    config: fakeConfig({ providers: ["linearb"] }),
    payload: makePayload(),
  });
  assert.equal(octokit.calls.length, 0);
});

test("auto-trigger: PRs targeting non-mainline branches are skipped by default", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig(),
    payload: makePayload({ base: { ref: "feature/some-branch" } }),
  });
  assert.equal(octokit.calls.length, 0);
});

test("auto-trigger: every default include branch is eligible", async (t) => {
  for (const ref of ["master", "main", "develop"]) {
    const octokit = makeOctokit();
    await dispatchAutoTrigger(t, {
      octokit,
      config: fakeConfig(),
      payload: makePayload({ base: { ref } }),
    });
    assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1, `expected invite for base ${ref}`);
  }
});

test("auto-trigger: branches patterns override the default list", async (t) => {
  const releaseOctokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit: releaseOctokit,
    config: fakeConfig({ ai_review: { branches: ["Release/*"] } }),
    payload: makePayload({ base: { ref: "release/1.2" } }),
  });
  assert.equal(countCalls(releaseOctokit, "rest.pulls.requestReviewers"), 1);

  // ...and the defaults no longer apply once overridden.
  const mainOctokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit: mainOctokit,
    config: fakeConfig({ ai_review: { branches: ["release/*"] } }),
    payload: makePayload({ base: { ref: "main" } }),
  });
  assert.equal(mainOctokit.calls.length, 0);
});

test("auto-trigger: negative branch patterns exclude", async (t) => {
  const keptOctokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit: keptOctokit,
    config: fakeConfig({ ai_review: { branches: ["**", "!test/**"] } }),
    payload: makePayload({ base: { ref: "feature/x" } }),
  });
  assert.equal(countCalls(keptOctokit, "rest.pulls.requestReviewers"), 1);

  const excludedOctokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit: excludedOctokit,
    config: fakeConfig({ ai_review: { branches: ["**", "!test/**"] } }),
    payload: makePayload({ base: { ref: "test/scratch" } }),
  });
  assert.equal(excludedOctokit.calls.length, 0);
});

test("auto-trigger: repositories patterns are respected (case-insensitive)", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    repo: "excluded-repo",
    config: fakeConfig({ ai_review: { repositories: ["*", "!Excluded-Repo"] } }),
    payload: makePayload(),
  });
  assert.equal(octokit.calls.length, 0);
});

test("auto-trigger: authors patterns are respected (case-insensitive)", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig({ ai_review: { authors: ["*", "!David"] } }),
    payload: makePayload(),
  });
  assert.equal(octokit.calls.length, 0);
});

test("auto-trigger: diffs below min_diff_size are skipped", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig({ ai_review: { min_diff_size: 16 } }),
    payload: makePayload({ additions: 10, deletions: 5 }), // 15 < 16
  });
  assert.equal(octokit.calls.length, 0);
});

test("auto-trigger: diffs above max_diff_size (default 2000) are skipped", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig(),
    payload: makePayload({ additions: 2000, deletions: 1 }), // 2001 > 2000
  });
  assert.equal(octokit.calls.length, 0);
});

test("auto-trigger: a diff exactly at the bounds is eligible", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig(),
    payload: makePayload({ additions: 2000, deletions: 0 }), // 2000 === max
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);
});

// ---------------------------------------------------------------------------
// Existing activity suppresses the invite
// ---------------------------------------------------------------------------

test("auto-trigger: a completed bot review suppresses the invite", async (t) => {
  const octokit = makeOctokit({
    "paginate:rest.pulls.listReviews": [
      { user: { login: "augmentcode[bot]", type: "Bot", id: 77 }, submitted_at: "2026-07-01T00:00:00Z" },
    ],
  });
  await dispatchAutoTrigger(t, {
    octokit,
    event: "pull_request.reopened",
    config: fakeConfig(),
    payload: makePayload(),
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 0);
});

test("auto-trigger: an already-requested Copilot suppresses the invite", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig(),
    payload: makePayload({
      requested_reviewers: [
        { login: "copilot-pull-request-reviewer[bot]", type: "Bot", id: 9 },
      ],
    }),
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 0);
});

test("auto-trigger: a requested human reviewer does NOT suppress the invite", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig(),
    payload: makePayload({
      requested_reviewers: [{ login: "some-human", type: "User", id: 2 }],
    }),
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);
});

test("auto-trigger: a pending Auggie summon suppresses the invite", async (t) => {
  const octokit = makeOctokit({
    "paginate:rest.issues.listComments": [
      { user: { login: "david", type: "User", id: 1 }, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
    ],
  });
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig({ providers: ["augment", "copilot"] }),
    payload: makePayload(),
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 0);
  assert.equal(countCalls(octokit, "rest.issues.createComment"), 0);
});

test("auto-trigger: a dangling summon for a disabled Augment doesn't block", async (t) => {
  const octokit = makeOctokit({
    "paginate:rest.issues.listComments": [
      { user: { login: "david", type: "User", id: 1 }, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
    ],
  });
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig({ providers: ["copilot"] }), // augment disabled
    payload: makePayload(),
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);
});

test("auto-trigger: a live gitStream run (incoming LinearB review) suppresses the invite", async (t) => {
  const octokit = makeOctokit({
    "rest.repos.getCombinedStatusForRef": {
      data: { statuses: [{ context: "gitStream.cm", state: "pending" }] },
    },
  });
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig({ providers: ["copilot", "linearb"] }),
    payload: makePayload(),
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 0);
});

test("auto-trigger: a failing gitStream run does not block the invite", async (t) => {
  const octokit = makeOctokit({
    "rest.repos.getCombinedStatusForRef": {
      data: { statuses: [{ context: "gitStream.cm", state: "failure" }] },
    },
  });
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig({ providers: ["copilot", "linearb"] }),
    payload: makePayload(),
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);
});

test("auto-trigger: gitStream status is ignored when LinearB is disabled", async (t) => {
  const octokit = makeOctokit({
    "rest.repos.getCombinedStatusForRef": {
      data: { statuses: [{ context: "gitStream.cm", state: "pending" }] },
    },
  });
  await dispatchAutoTrigger(t, {
    octokit,
    config: fakeConfig({ providers: ["copilot"] }), // linearb disabled
    payload: makePayload(),
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test("auto-trigger: an eligible opened PR summons one reviewer after the delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const octokit = makeOctokit();
  const { app, dispatch } = makeApp();
  register(app);
  const context = makeContext({ octokit, config: fakeConfig(), payload: makePayload() });

  await dispatch("pull_request.opened", context);

  // Nothing happens until the evaluation delay elapses...
  assert.equal(octokit.calls.length, 0);

  await flushEvaluateDelay(t);

  const requests = octokit.calls.filter((c) => c.method === "rest.pulls.requestReviewers");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].args.reviewers, ["copilot-pull-request-reviewer[bot]"]);
});

test("auto-trigger: ready_for_review also summons", async (t) => {
  const octokit = makeOctokit();
  await dispatchAutoTrigger(t, {
    octokit,
    event: "pull_request.ready_for_review",
    config: fakeConfig(),
    payload: makePayload(),
  });
  assert.equal(countCalls(octokit, "rest.pulls.requestReviewers"), 1);
});
