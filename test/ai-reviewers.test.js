import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_REVIEW_TEAM,
  AUGGIE_REVIEW_TEAM,
  AUGMENT_PENDING_MARKER,
  detectPendingAiReviewRequests,
  getBotDisplayName,
  getBotKey,
  hasCompletedAiReview,
  hasPendingAuggieSummon,
  isAuggieCommandComment,
  isBotUser,
} from "../lib/ai-reviewers.js";

// ---------------------------------------------------------------------------
// getBotDisplayName
// ---------------------------------------------------------------------------

test("getBotDisplayName: maps known bot logins to friendly names", () => {
  assert.equal(getBotDisplayName("augmentcode[bot]"), "Auggie");
  assert.equal(getBotDisplayName("Claude"), "Claude");
  assert.equal(getBotDisplayName("copilot-pull-request-reviewer[bot]"), "Copilot");
  assert.equal(getBotDisplayName("greptileai[bot]"), "Greptile");
  assert.equal(getBotDisplayName("linearb-bot[bot]"), "LinearB");
  assert.equal(getBotDisplayName("dusty-the-robot[bot]"), "Dusty");
});

test("getBotDisplayName: exact-login names don't match other logins containing the substring", () => {
  assert.equal(getBotDisplayName("dustyrhodes"), "dustyrhodes");
  assert.equal(getBotDisplayName("dusty-the-robot"), "dusty-the-robot");
});

test("getBotDisplayName: falls back to the raw login when unknown", () => {
  assert.equal(getBotDisplayName("some-random-bot"), "some-random-bot");
});

test("getBotDisplayName: handles null/undefined login", () => {
  assert.equal(getBotDisplayName(null), null);
  assert.equal(getBotDisplayName(undefined), undefined);
});

// ---------------------------------------------------------------------------
// isBotUser
// ---------------------------------------------------------------------------

test("isBotUser: true for type Bot", () => {
  assert.ok(isBotUser({ type: "Bot" }));
});

test("isBotUser: true for logins ending in [bot]", () => {
  assert.ok(isBotUser({ login: "dependabot[bot]" }));
});

test("isBotUser: false for humans and missing users", () => {
  // Note: the predicate is used for truthiness, so it may return undefined
  // rather than a literal false for null-ish inputs.
  assert.ok(!isBotUser({ type: "User", login: "david" }));
  assert.ok(!isBotUser(null));
  assert.ok(!isBotUser(undefined));
  assert.ok(!isBotUser({}));
});

// ---------------------------------------------------------------------------
// getBotKey
// ---------------------------------------------------------------------------

test("getBotKey: extracts the provider key from a login", () => {
  assert.equal(getBotKey("augmentcode[bot]"), "augment");
  assert.equal(getBotKey("Copilot"), "copilot");
  assert.equal(getBotKey("greptileai[bot]"), "greptile");
  assert.equal(getBotKey("linearb-bot[bot]"), "linearb");
  assert.equal(getBotKey("claude[bot]"), "claude");
});

test("getBotKey: null for unknown or missing logins", () => {
  assert.equal(getBotKey("dependabot[bot]"), null);
  assert.equal(getBotKey(null), null);
  assert.equal(getBotKey(undefined), null);
  assert.equal(getBotKey(""), null);
});

// ---------------------------------------------------------------------------
// Team matching
// ---------------------------------------------------------------------------

test("AI_REVIEW_TEAM / AUGGIE_REVIEW_TEAM: team slug matching", () => {
  assert.ok(AI_REVIEW_TEAM.test("ai-review-team"));
  assert.ok(AI_REVIEW_TEAM.test("AI Review"));
  assert.ok(AUGGIE_REVIEW_TEAM.test("auggie-reviewers"));
  assert.equal(AUGGIE_REVIEW_TEAM.test("backend-team"), false);
});

// ---------------------------------------------------------------------------
// isAuggieCommandComment
// ---------------------------------------------------------------------------

test("isAuggieCommandComment: matches standalone summon commands", () => {
  assert.ok(isAuggieCommandComment("auggie review"));
  assert.ok(isAuggieCommandComment("Auggie Review"));
  assert.ok(isAuggieCommandComment("  augment review  "));
  assert.ok(isAuggieCommandComment("`auggie review`"));
  assert.ok(isAuggieCommandComment("augmentcode review"));
});

test("isAuggieCommandComment: does not match mentions inside prose", () => {
  assert.equal(isAuggieCommandComment("please auggie review this"), false);
  // The summon-failed reply mentions the command but is not a live request.
  assert.equal(
    isAuggieCommandComment(
      "Hmm... Auggie still hasn't acknowledged. Try commenting `auggie review` manually."
    ),
    false
  );
  assert.equal(isAuggieCommandComment(null), false);
  assert.equal(isAuggieCommandComment(undefined), false);
});

// ---------------------------------------------------------------------------
// hasPendingAuggieSummon
// ---------------------------------------------------------------------------

const AUGGIE = { login: "augmentcode[bot]", type: "Bot", id: 77 };
const HUMAN = { login: "david", type: "User", id: 1 };

test("hasPendingAuggieSummon: pending marker comment reads as pending", () => {
  assert.ok(
    hasPendingAuggieSummon({
      issueComments: [
        { user: AUGGIE, body: `${AUGMENT_PENDING_MARKER}\nSummoning...`, created_at: "2026-07-01T00:00:00Z" },
      ],
    })
  );
});

test("hasPendingAuggieSummon: unanswered summon command reads as pending", () => {
  assert.ok(
    hasPendingAuggieSummon({
      issueComments: [
        { user: HUMAN, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
      ],
      reviews: [],
    })
  );
});

test("hasPendingAuggieSummon: an Augment review after the command clears it", () => {
  assert.equal(
    hasPendingAuggieSummon({
      issueComments: [
        { user: HUMAN, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
      ],
      reviews: [
        { user: AUGGIE, submitted_at: "2026-07-01T00:05:00Z" },
      ],
    }),
    false
  );
});

test("hasPendingAuggieSummon: a command after the last Augment review re-requests", () => {
  assert.ok(
    hasPendingAuggieSummon({
      issueComments: [
        { user: HUMAN, body: "auggie review", created_at: "2026-07-02T00:00:00Z" },
      ],
      reviews: [
        { user: AUGGIE, submitted_at: "2026-07-01T00:00:00Z" },
      ],
    })
  );
});

test("hasPendingAuggieSummon: an Augment comment after the command clears it", () => {
  assert.equal(
    hasPendingAuggieSummon({
      issueComments: [
        { user: HUMAN, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
        { user: AUGGIE, body: "Here's my summary", created_at: "2026-07-01T00:03:00Z" },
      ],
    }),
    false
  );
});

test("hasPendingAuggieSummon: nothing pending on a quiet PR", () => {
  assert.equal(hasPendingAuggieSummon({ issueComments: [], reviews: [] }), false);
  assert.equal(
    hasPendingAuggieSummon({
      issueComments: [{ user: HUMAN, body: "nice work", created_at: "2026-07-01T00:00:00Z" }],
    }),
    false
  );
});

// ---------------------------------------------------------------------------
// detectPendingAiReviewRequests
// ---------------------------------------------------------------------------

const COPILOT_REVIEWER = {
  login: "copilot-pull-request-reviewer[bot]",
  type: "Bot",
  id: 9,
};

test("detectPendingAiReviewRequests: bot requested_reviewers become requests", () => {
  const requests = detectPendingAiReviewRequests({
    pr: { requested_reviewers: [COPILOT_REVIEWER, HUMAN] },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "copilot");
  assert.equal(requests[0].displayName, "Copilot");
  assert.equal(requests[0].userId, 9);
});

test("detectPendingAiReviewRequests: auggie and ai-review team requests", () => {
  const requests = detectPendingAiReviewRequests({
    pr: {
      requested_teams: [
        { slug: "auggie-reviewers", name: "Auggie" },
        { slug: "ai-review", name: "AI Review" },
        { slug: "backend", name: "Backend" },
      ],
    },
  });
  assert.deepEqual(
    requests.map((r) => r.displayName).sort(),
    ["AI review", "Auggie"]
  );
});

test("detectPendingAiReviewRequests: a pending summon adds a single Auggie entry", () => {
  const requests = detectPendingAiReviewRequests({
    pr: { requested_teams: [{ slug: "auggie", name: "Auggie" }] },
    issueComments: [
      { user: HUMAN, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
    ],
  });
  // Team request + live summon de-dupe into one Auggie entry.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "augment");
});

test("detectPendingAiReviewRequests: augmentEnabled=false ignores summon comments", () => {
  const requests = detectPendingAiReviewRequests({
    pr: {},
    issueComments: [
      { user: HUMAN, body: "auggie review", created_at: "2026-07-01T00:00:00Z" },
    ],
    augmentEnabled: false,
  });
  assert.equal(requests.length, 0);
});

test("detectPendingAiReviewRequests: empty PR yields no requests", () => {
  assert.deepEqual(detectPendingAiReviewRequests({ pr: {} }), []);
});

test("detectPendingAiReviewRequests: a non-failing gitStream status means LinearB", () => {
  for (const state of ["pending", "success"]) {
    const requests = detectPendingAiReviewRequests({
      pr: {},
      statuses: [{ context: "gitStream.cm", state }],
    });
    assert.equal(requests.length, 1, `state ${state}`);
    assert.equal(requests[0].provider, "linearb");
    assert.equal(requests[0].displayName, "LinearB");
  }
});

test("detectPendingAiReviewRequests: failing gitStream statuses are not requests", () => {
  for (const state of ["failure", "error"]) {
    const requests = detectPendingAiReviewRequests({
      pr: {},
      statuses: [{ context: "gitStream.cm", state }],
    });
    assert.equal(requests.length, 0, `state ${state}`);
  }
});

test("detectPendingAiReviewRequests: unrelated statuses are ignored", () => {
  const requests = detectPendingAiReviewRequests({
    pr: {},
    statuses: [
      { context: "ci/build", state: "pending" },
      { context: "AI Review", state: "success" },
    ],
  });
  assert.equal(requests.length, 0);
});

test("detectPendingAiReviewRequests: linearbEnabled=false ignores gitStream", () => {
  const requests = detectPendingAiReviewRequests({
    pr: {},
    statuses: [{ context: "gitStream.cm", state: "pending" }],
    linearbEnabled: false,
  });
  assert.equal(requests.length, 0);
});

// ---------------------------------------------------------------------------
// hasCompletedAiReview
// ---------------------------------------------------------------------------

test("hasCompletedAiReview: bot-submitted reviews count", () => {
  assert.ok(hasCompletedAiReview([{ user: AUGGIE }]));
  assert.ok(hasCompletedAiReview([{ user: HUMAN }, { user: COPILOT_REVIEWER }]));
});

test("hasCompletedAiReview: human reviews and empty lists do not", () => {
  assert.equal(hasCompletedAiReview([{ user: HUMAN }]), false);
  assert.equal(hasCompletedAiReview([]), false);
  assert.equal(hasCompletedAiReview(), false);
});
