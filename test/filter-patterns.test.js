import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compileFilterPatterns,
  matchesFilterPatterns,
} from "../lib/filter-patterns.js";

function matches(patterns, value) {
  return matchesFilterPatterns(compileFilterPatterns(patterns), value);
}

test("filter patterns: literal matching is exact and case-insensitive", () => {
  assert.ok(matches(["main"], "main"));
  assert.ok(matches(["main"], "MAIN"));
  assert.equal(matches(["main"], "main2"), false);
  assert.equal(matches(["main"], "not-main"), false);
});

test("filter patterns: * matches within a path segment only", () => {
  assert.ok(matches(["*"], "main"));
  assert.equal(matches(["*"], "test/foo"), false);
  assert.ok(matches(["release/*"], "release/1.2"));
  assert.equal(matches(["release/*"], "release/1/2"), false);
});

test("filter patterns: ** matches across segments", () => {
  assert.ok(matches(["**"], "main"));
  assert.ok(matches(["**"], "test/foo/bar"));
  assert.ok(matches(["**"], ""));
  assert.ok(matches(["release/**"], "release/1/2"));
});

test("filter patterns: ! negates a previous match", () => {
  assert.ok(matches(["**", "!test/**"], "src/thing"));
  assert.equal(matches(["**", "!test/**"], "test/thing"), false);
});

test("filter patterns: the GitHub Actions example shape works", () => {
  const patterns = ["*", "!master", "!test/*"];
  assert.ok(matches(patterns, "develop"));
  assert.equal(matches(patterns, "master"), false);
  assert.equal(matches(patterns, "test/unit"), false);
});

test("filter patterns: order matters — a later positive re-includes", () => {
  const patterns = ["**", "!test/**", "test/keep"];
  assert.equal(matches(patterns, "test/other"), false);
  assert.ok(matches(patterns, "test/keep"));
});

test("filter patterns: only-negative lists match nothing (as in Actions)", () => {
  assert.equal(matches(["!master"], "develop"), false);
  assert.equal(matches(["!master"], "master"), false);
});

test("filter patterns: ? and + quantify the preceding character", () => {
  assert.ok(matches(["ma?in"], "main"));
  assert.ok(matches(["ma?in"], "min"));
  assert.equal(matches(["ma?in"], "maain"), false);
  assert.ok(matches(["va+"], "va"));
  assert.ok(matches(["va+"], "vaaa"));
  assert.equal(matches(["va+"], "v"), false);
});

test("filter patterns: [] character ranges", () => {
  assert.ok(matches(["v[0-9]"], "v1"));
  assert.equal(matches(["v[0-9]"], "va"), false);
});

test("filter patterns: [] also matches the bracketed text literally", () => {
  assert.ok(matches(["dependabot[bot]"], "dependabot[bot]"));
  assert.ok(matches(["dependabot[bot]"], "DEPENDABOT[BOT]"));
  assert.equal(matches(["dependabot[bot]"], "dependabot"), false);
});

test("filter patterns: bot logins can be excluded by name", () => {
  const patterns = ["*", "!healthengine-sre", "!dependabot[bot]", "!github-actions[bot]"];
  assert.ok(matches(patterns, "david"));
  assert.equal(matches(patterns, "healthengine-sre"), false);
  assert.equal(matches(patterns, "dependabot[bot]"), false);
  assert.equal(matches(patterns, "github-actions[bot]"), false);
  // A different bot is still eligible.
  assert.ok(matches(patterns, "renovate[bot]"));
});

test("filter patterns: regex specials in patterns are literal", () => {
  assert.ok(matches(["a.b"], "a.b"));
  assert.equal(matches(["a.b"], "axb"), false);
  // An unclosed bracket is treated as a literal character.
  assert.ok(matches(["a[b"], "a[b"));
});

test("filter patterns: invalid patterns are dropped, valid ones kept", (t) => {
  t.mock.method(console, "warn", () => {});
  // "?bad" compiles to a regex with a leading quantifier, which is invalid.
  const compiled = compileFilterPatterns(["?bad", "main"]);
  assert.equal(compiled.length, 1);
  assert.ok(matchesFilterPatterns(compiled, "main"));
  assert.equal(console.warn.mock.callCount(), 1);
});
