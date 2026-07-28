import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  KNOWN_PROVIDERS,
  normalizeAiReview,
  normalizeBotPrHumanApprovers,
  normalizeProviders,
  normalizeSkipAuthors,
  loadAiReviewConfig,
} from "../lib/config.js";
import { matchesFilterPatterns } from "../lib/filter-patterns.js";

// Several tests here intentionally exercise the "unknown provider" and
// "config load failed" branches, which log via console.warn/error. Silence
// them so the expected noise doesn't clutter test output.
let originalWarn;
let originalError;
beforeEach(() => {
  originalWarn = console.warn;
  originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
});
afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
});

// ---------------------------------------------------------------------------
// normalizeProviders
// ---------------------------------------------------------------------------

test("normalizeProviders: returns null for non-arrays", () => {
  assert.equal(normalizeProviders(undefined), null);
  assert.equal(normalizeProviders(null), null);
  assert.equal(normalizeProviders("claude"), null);
  assert.equal(normalizeProviders({ providers: [] }), null);
});

test("normalizeProviders: returns null for an empty or all-invalid list", () => {
  assert.equal(normalizeProviders([]), null);
  assert.equal(normalizeProviders(["nonsense", "", "  "]), null);
  assert.equal(normalizeProviders([123, {}, null]), null);
});

test("normalizeProviders: keeps only known providers, lower-cased and trimmed", () => {
  const result = normalizeProviders(["  Claude ", "COPILOT", "augment"]);
  assert.ok(result instanceof Set);
  assert.deepEqual([...result].sort(), ["augment", "claude", "copilot"]);
});

test("normalizeProviders: drops unknown providers but keeps valid ones", () => {
  const result = normalizeProviders(["claude", "skynet"]);
  assert.deepEqual([...result], ["claude"]);
});

test("normalizeProviders: de-duplicates repeated providers", () => {
  const result = normalizeProviders(["claude", "claude", "Claude"]);
  assert.equal(result.size, 1);
});

test("normalizeProviders: every KNOWN_PROVIDER round-trips", () => {
  const result = normalizeProviders(KNOWN_PROVIDERS);
  assert.deepEqual([...result].sort(), [...KNOWN_PROVIDERS].sort());
});

// ---------------------------------------------------------------------------
// loadAiReviewConfig
// ---------------------------------------------------------------------------

// Build a fake Probot context whose repo() is unique per test (so the module's
// per-repo cache doesn't leak state between cases), and whose config() resolves
// or rejects with whatever the test provides.
let repoCounter = 0;
function makeContext({ configValue, configError } = {}) {
  const repo = `repo-${repoCounter++}`;
  return {
    repo: () => ({ owner: "acme", repo }),
    config: async () => {
      if (configError) throw configError;
      return configValue;
    },
  };
}

test("loadAiReviewConfig: uses providers from the config file", async () => {
  const ctx = makeContext({ configValue: { providers: ["claude", "copilot"] } });
  const config = await loadAiReviewConfig(ctx);
  assert.ok(config.isProviderEnabled("claude"));
  assert.ok(config.isProviderEnabled("copilot"));
  assert.equal(config.isProviderEnabled("augment"), false);
});

test("loadAiReviewConfig: falls back to all providers when no config file", async () => {
  const ctx = makeContext({ configValue: null });
  const config = await loadAiReviewConfig(ctx);
  for (const provider of KNOWN_PROVIDERS) {
    assert.ok(config.isProviderEnabled(provider), `${provider} should be enabled`);
  }
});

test("loadAiReviewConfig: falls back to all providers when the list is empty/invalid", async () => {
  const ctx = makeContext({ configValue: { providers: ["bogus"] } });
  const config = await loadAiReviewConfig(ctx);
  assert.equal(config.providers.size, KNOWN_PROVIDERS.length);
});

test("loadAiReviewConfig: falls back to defaults when config() throws", async () => {
  const ctx = makeContext({ configError: new Error("network down") });
  const config = await loadAiReviewConfig(ctx);
  assert.equal(config.providers.size, KNOWN_PROVIDERS.length);
});

test("loadAiReviewConfig: caches per repo (config() called once)", async () => {
  let calls = 0;
  const ctx = {
    repo: () => ({ owner: "acme", repo: "cache-repo" }),
    config: async () => {
      calls++;
      return { providers: ["claude"] };
    },
  };
  await loadAiReviewConfig(ctx);
  await loadAiReviewConfig(ctx);
  assert.equal(calls, 1);
});

test("loadAiReviewConfig: exposes a providers Set and isProviderEnabled()", async () => {
  const ctx = makeContext({ configValue: { providers: ["greptile"] } });
  const config = await loadAiReviewConfig(ctx);
  assert.ok(config.providers instanceof Set);
  assert.equal(typeof config.isProviderEnabled, "function");
  assert.ok(config.isProviderEnabled("greptile"));
});

// ---------------------------------------------------------------------------
// normalizeSkipAuthors
// ---------------------------------------------------------------------------

test("normalizeSkipAuthors: returns null for non-arrays", () => {
  assert.equal(normalizeSkipAuthors(undefined), null);
  assert.equal(normalizeSkipAuthors(null), null);
  assert.equal(normalizeSkipAuthors("dependabot[bot]"), null);
  assert.equal(normalizeSkipAuthors({}), null);
});

test("normalizeSkipAuthors: an explicit empty list means skip no one", () => {
  const result = normalizeSkipAuthors([]);
  assert.ok(result instanceof Set);
  assert.equal(result.size, 0);
});

test("normalizeSkipAuthors: lower-cases, trims, and drops junk entries", () => {
  const result = normalizeSkipAuthors(["  Dependabot[bot] ", "RENOVATE[bot]", "", 42, null]);
  assert.deepEqual([...result].sort(), ["dependabot[bot]", "renovate[bot]"]);
});

test("loadAiReviewConfig: ai_review.skip_authors defaults to dependabot[bot]", async () => {
  const ctx = makeContext({ configValue: null });
  const config = await loadAiReviewConfig(ctx);
  assert.deepEqual([...config.aiReview.skipAuthors], ["dependabot[bot]"]);
  assert.ok(config.isAuthorSkipped("dependabot[bot]"));
  assert.ok(config.isAuthorSkipped("Dependabot[bot]"));
  assert.equal(config.isAuthorSkipped("renovate[bot]"), false);
  assert.equal(config.isAuthorSkipped("david"), false);
  assert.equal(config.isAuthorSkipped(null), false);
  assert.equal(config.isAuthorSkipped(undefined), false);
});

test("loadAiReviewConfig: ai_review.skip_authors replaces the default", async () => {
  const ctx = makeContext({
    configValue: { ai_review: { skip_authors: ["renovate[bot]", "deploy-bot"] } },
  });
  const config = await loadAiReviewConfig(ctx);
  assert.ok(config.isAuthorSkipped("renovate[bot]"));
  assert.ok(config.isAuthorSkipped("Deploy-Bot"));
  assert.equal(config.isAuthorSkipped("dependabot[bot]"), false);
});

test("loadAiReviewConfig: ai_review.skip_authors [] disables the skip entirely", async () => {
  const ctx = makeContext({ configValue: { ai_review: { skip_authors: [] } } });
  const config = await loadAiReviewConfig(ctx);
  assert.equal(config.aiReview.skipAuthors.size, 0);
  assert.equal(config.isAuthorSkipped("dependabot[bot]"), false);
});

// ---------------------------------------------------------------------------
// normalizeAiReview
// ---------------------------------------------------------------------------

test("normalizeAiReview: defaults for missing or junk values", () => {
  for (const raw of [undefined, null, {}, "nonsense", 42]) {
    const result = normalizeAiReview(raw);
    // Automatic invites are opt-in, and drafts are excluded by default.
    assert.equal(result.automatic, false);
    assert.equal(result.includeDrafts, false);
    // Branches default to the mainline trio…
    for (const branch of ["master", "main", "develop"]) {
      assert.ok(matchesFilterPatterns(result.branches, branch), branch);
    }
    assert.equal(matchesFilterPatterns(result.branches, "feature/x"), false);
    // …while repositories and authors default to match-everything.
    assert.ok(matchesFilterPatterns(result.repositories, "any-repo"));
    assert.ok(matchesFilterPatterns(result.authors, "anyone"));
    assert.equal(result.minDiffSize, 0);
    assert.equal(result.maxDiffSize, 2000);
  }
});

test("normalizeAiReview: a pattern list replaces its default entirely", () => {
  const result = normalizeAiReview({ branches: ["Release/*", "  main "] });
  assert.ok(matchesFilterPatterns(result.branches, "release/1.2"));
  assert.ok(matchesFilterPatterns(result.branches, "main"));
  assert.equal(matchesFilterPatterns(result.branches, "develop"), false);
});

test("normalizeAiReview: negative patterns exclude", () => {
  const result = normalizeAiReview({
    repositories: ["*", "!legacy-monolith"],
    authors: ["*", "!*-service-account"],
  });
  assert.ok(matchesFilterPatterns(result.repositories, "normal-repo"));
  assert.equal(matchesFilterPatterns(result.repositories, "Legacy-Monolith"), false);
  assert.ok(matchesFilterPatterns(result.authors, "david"));
  assert.equal(matchesFilterPatterns(result.authors, "deploy-service-account"), false);
});

test("normalizeAiReview: empty/invalid pattern lists fall back to defaults", () => {
  for (const bad of [[], ["", 42, null], "main"]) {
    const result = normalizeAiReview({ branches: bad, repositories: bad, authors: bad });
    assert.ok(matchesFilterPatterns(result.branches, "main"), `branches for ${JSON.stringify(bad)}`);
    assert.equal(matchesFilterPatterns(result.branches, "feature/x"), false);
    assert.ok(matchesFilterPatterns(result.repositories, "any-repo"), `repos for ${JSON.stringify(bad)}`);
    assert.ok(matchesFilterPatterns(result.authors, "anyone"), `authors for ${JSON.stringify(bad)}`);
  }
});

test("normalizeAiReview: automatic is a strict opt-in", () => {
  assert.equal(normalizeAiReview({ automatic: true }).automatic, true);
  for (const raw of [{}, { automatic: false }, { automatic: "yes" }, { automatic: 1 }]) {
    assert.equal(normalizeAiReview(raw).automatic, false, JSON.stringify(raw));
  }
});

test("normalizeAiReview: drafts are excluded unless include_drafts: true", () => {
  assert.equal(normalizeAiReview({ include_drafts: true }).includeDrafts, true);
  for (const raw of [{}, { include_drafts: false }, { include_drafts: "yes" }]) {
    assert.equal(normalizeAiReview(raw).includeDrafts, false, JSON.stringify(raw));
  }
});

test("normalizeAiReview: pattern entries are trimmed and junk is dropped", () => {
  const result = normalizeAiReview({
    repositories: ["  My-Repo ", "", 42, null],
  });
  assert.ok(matchesFilterPatterns(result.repositories, "my-repo"));
  assert.equal(matchesFilterPatterns(result.repositories, "other-repo"), false);
});

test("normalizeAiReview: diff bounds accept valid numbers, including 0", () => {
  const result = normalizeAiReview({ min_diff_size: 5, max_diff_size: 100 });
  assert.equal(result.minDiffSize, 5);
  assert.equal(result.maxDiffSize, 100);
  assert.equal(normalizeAiReview({ max_diff_size: 0 }).maxDiffSize, 0);
});

test("normalizeAiReview: invalid diff bounds fall back to defaults", () => {
  for (const bad of ["500", -1, NaN, Infinity, {}, []]) {
    const result = normalizeAiReview({ min_diff_size: bad, max_diff_size: bad });
    assert.equal(result.minDiffSize, 0, `min for ${String(bad)}`);
    assert.equal(result.maxDiffSize, 2000, `max for ${String(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// normalizeBotPrHumanApprovers
// ---------------------------------------------------------------------------

test("normalizeBotPrHumanApprovers: defaults for missing or junk values", () => {
  for (const raw of [undefined, null, {}, "nonsense", 42, []]) {
    const result = normalizeBotPrHumanApprovers(raw);
    assert.equal(result.min, 2, JSON.stringify(raw));
    assert.deepEqual([...result.exclude], ["dependabot[bot]"], JSON.stringify(raw));
  }
});

test("normalizeBotPrHumanApprovers: accepts valid min, including 0", () => {
  assert.equal(normalizeBotPrHumanApprovers({ min: 2 }).min, 2);
  assert.equal(normalizeBotPrHumanApprovers({ min: 0 }).min, 0);
});

test("normalizeBotPrHumanApprovers: invalid min falls back to 2", () => {
  for (const bad of ["2", -1, NaN, Infinity, {}, [], null]) {
    assert.equal(normalizeBotPrHumanApprovers({ min: bad }).min, 2, String(bad));
  }
});

test("normalizeBotPrHumanApprovers: exclude replaces the default, lower-cased", () => {
  const result = normalizeBotPrHumanApprovers({ exclude: ["  Renovate[bot] ", "", 42] });
  assert.deepEqual([...result.exclude], ["renovate[bot]"]);
});

test("normalizeBotPrHumanApprovers: an explicit empty exclude means no exemptions", () => {
  const result = normalizeBotPrHumanApprovers({ exclude: [] });
  assert.equal(result.exclude.size, 0);
});

test("normalizeAiReview: exposes botPrHumanApprovers with defaults", () => {
  const result = normalizeAiReview({});
  assert.equal(result.botPrHumanApprovers.min, 2);
  assert.deepEqual([...result.botPrHumanApprovers.exclude], ["dependabot[bot]"]);
});

test("loadAiReviewConfig: exposes ai_review.bot_pr_human_approvers", async () => {
  const ctx = makeContext({
    configValue: {
      ai_review: { bot_pr_human_approvers: { min: 2, exclude: ["renovate[bot]"] } },
    },
  });
  const config = await loadAiReviewConfig(ctx);
  assert.equal(config.aiReview.botPrHumanApprovers.min, 2);
  assert.deepEqual([...config.aiReview.botPrHumanApprovers.exclude], ["renovate[bot]"]);
});

test("loadAiReviewConfig: exposes normalized aiReview settings", async () => {
  const ctx = makeContext({
    configValue: {
      providers: ["claude"],
      ai_review: { automatic: true, repositories: ["*", "!Legacy-Repo"] },
    },
  });
  const config = await loadAiReviewConfig(ctx);
  assert.equal(config.aiReview.automatic, true);
  assert.ok(matchesFilterPatterns(config.aiReview.repositories, "some-repo"));
  assert.equal(matchesFilterPatterns(config.aiReview.repositories, "legacy-repo"), false);
});

test("loadAiReviewConfig: aiReview defaults apply when the key is absent", async () => {
  const ctx = makeContext({ configValue: { providers: ["claude"] } });
  const config = await loadAiReviewConfig(ctx);
  assert.equal(config.aiReview.automatic, false);
  assert.equal(config.aiReview.maxDiffSize, 2000);
});
