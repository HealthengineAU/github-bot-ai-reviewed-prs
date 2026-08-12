import { test } from "node:test";
import assert from "node:assert/strict";

import { BOT, EFFORT } from "../lib/ai-reviewers.js";
import { normalizeAiReview } from "../lib/config.js";
import {
  TIER,
  chooseReviewer,
  expensiveOnSmallPrNotice,
  isExpensiveChoice,
  isMechanicalPr,
  needsFileList,
  resolveTier,
} from "../lib/review-routing.js";

const aiReview = (raw = {}) => normalizeAiReview(raw);

function fakeConfig({ providers = [BOT.Augment, BOT.Copilot], raw = {} } = {}) {
  const set = new Set(providers);
  return {
    providers: set,
    aiReview: aiReview(raw),
    isProviderEnabled: (provider) => set.has(provider),
  };
}

// ---------------------------------------------------------------------------
// isMechanicalPr
// ---------------------------------------------------------------------------

test("isMechanicalPr: under the threshold is mechanical", () => {
  assert.equal(
    isMechanicalPr({ pr: { additions: 40, deletions: 20 }, aiReview: aiReview() }),
    true
  );
});

test("isMechanicalPr: at the threshold is mechanical, over it is not", () => {
  const config = aiReview();
  assert.equal(isMechanicalPr({ pr: { additions: 100, deletions: 0 }, aiReview: config }), true);
  assert.equal(isMechanicalPr({ pr: { additions: 100, deletions: 1 }, aiReview: config }), false);
});

test("isMechanicalPr: honours a configured mechanical_max_diff_size", () => {
  const config = aiReview({ mechanical_max_diff_size: 10 });
  assert.equal(isMechanicalPr({ pr: { additions: 11, deletions: 0 }, aiReview: config }), false);
});

test("isMechanicalPr: mechanical_paths requires every file to match", () => {
  const config = aiReview({ mechanical_paths: ["docs/**", "*.md"] });
  assert.equal(needsFileList(config), true);
  const pr = { additions: 5, deletions: 1 };
  assert.equal(
    isMechanicalPr({ pr, aiReview: config, files: [{ filename: "docs/a.txt" }, { filename: "README.md" }] }),
    true
  );
  assert.equal(
    isMechanicalPr({ pr, aiReview: config, files: [{ filename: "docs/a.txt" }, { filename: "lib/app.js" }] }),
    false
  );
});

test("isMechanicalPr: mechanical_paths without a file list is not mechanical", () => {
  const config = aiReview({ mechanical_paths: ["docs/**"] });
  assert.equal(isMechanicalPr({ pr: { additions: 1, deletions: 0 }, aiReview: config }), false);
});

test("needsFileList: false when mechanical_paths is unset", () => {
  assert.equal(needsFileList(aiReview()), false);
});

// ---------------------------------------------------------------------------
// resolveTier
// ---------------------------------------------------------------------------

test("resolveTier: mechanical PRs get the lite tier", () => {
  assert.equal(
    resolveTier({ mechanical: true, hasExistingReview: false, aiReview: aiReview() }),
    TIER.Lite
  );
});

test("resolveTier: non-mechanical PRs get the expensive tier", () => {
  assert.equal(
    resolveTier({ mechanical: false, hasExistingReview: false, aiReview: aiReview() }),
    TIER.Expensive
  );
});

test("resolveTier: a top-up on an already-reviewed PR is lite", () => {
  assert.equal(
    resolveTier({ mechanical: false, hasExistingReview: true, aiReview: aiReview() }),
    TIER.Lite
  );
});

test("resolveTier: top_up_lite: false keeps the size-based tier", () => {
  assert.equal(
    resolveTier({
      mechanical: false,
      hasExistingReview: true,
      aiReview: aiReview({ top_up_lite: false }),
    }),
    TIER.Expensive
  );
});

// ---------------------------------------------------------------------------
// chooseReviewer
// ---------------------------------------------------------------------------

test("chooseReviewer: lite picks Copilot when the default effort is lite", () => {
  assert.deepEqual(chooseReviewer({ tier: TIER.Lite, config: fakeConfig() }), {
    provider: BOT.Copilot,
    effort: EFFORT.Lite,
  });
});

test("chooseReviewer: expensive picks Auggie when Copilot can only do lite", () => {
  assert.deepEqual(chooseReviewer({ tier: TIER.Expensive, config: fakeConfig() }), {
    provider: BOT.Augment,
    effort: null,
  });
});

test("chooseReviewer: expensive can pick Copilot Balanced when it's available", () => {
  const config = fakeConfig({ raw: { copilot_efforts: ["balanced"] } });
  const first = chooseReviewer({ tier: TIER.Expensive, config, random: () => 0 });
  const second = chooseReviewer({ tier: TIER.Expensive, config, random: () => 0.99 });
  assert.deepEqual(first, { provider: BOT.Augment, effort: null });
  assert.deepEqual(second, { provider: BOT.Copilot, effort: EFFORT.Balanced });
});

test("chooseReviewer: lite falls back to the expensive pool when Copilot is disabled", () => {
  const config = fakeConfig({ providers: [BOT.Augment] });
  assert.deepEqual(chooseReviewer({ tier: TIER.Lite, config }), {
    provider: BOT.Augment,
    effort: null,
  });
});

test("chooseReviewer: expensive falls back to Copilot when nothing else is enabled", () => {
  const config = fakeConfig({ providers: [BOT.Copilot] });
  assert.deepEqual(chooseReviewer({ tier: TIER.Expensive, config }), {
    provider: BOT.Copilot,
    effort: EFFORT.Lite,
  });
});

test("chooseReviewer: returns null when no summonable provider is enabled", () => {
  const config = fakeConfig({ providers: [BOT.Greptile] });
  assert.equal(chooseReviewer({ tier: TIER.Expensive, config }), null);
});

// ---------------------------------------------------------------------------
// Advisory notice
// ---------------------------------------------------------------------------

test("isExpensiveChoice: only a lite Copilot review is cheap", () => {
  assert.equal(isExpensiveChoice({ provider: BOT.Copilot, effort: EFFORT.Lite }), false);
  assert.equal(isExpensiveChoice({ provider: BOT.Copilot, effort: EFFORT.Balanced }), true);
  assert.equal(isExpensiveChoice({ provider: BOT.Augment, effort: null }), true);
  assert.equal(isExpensiveChoice(null), false);
});

test("expensiveOnSmallPrNotice: names the reviewer and the diff size", () => {
  const body = expensiveOnSmallPrNotice({
    choice: { provider: BOT.Augment, effort: null },
    pr: { additions: 8, deletions: 4 },
  });
  assert.match(body, /Auggie/);
  assert.match(body, /12-line/);
  assert.match(body, /Copilot \(Lite\)/);
});
