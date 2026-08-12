// Picks *which* AI reviewer a request should go to, based on how expensive the
// change looks. Small mechanical PRs get a cheap review (Copilot Lite); bigger
// or riskier ones get an expensive one (Auggie, or Copilot Balanced); a PR that
// already carries an AI review gets a cheap top-up.
//
// Effort levels caveat: GitHub has no per-request effort parameter — Copilot
// reviews run at the org/repo default. `ai_review.copilot_efforts` declares
// which levels that default actually makes available to us, so routing can
// avoid promising a level we can't get.

import {
  BOT,
  EFFORT,
  PROVIDER_DISPLAY_NAMES,
  triggerAugmentReviewer,
  triggerCopilotReviewer,
} from "./ai-reviewers.js";
import { matchesFilterPatterns } from "./filter-patterns.js";

export const TIER = {
  Lite: "lite",
  Expensive: "expensive",
};

// True when the changed files still need fetching to classify the PR — only
// the case when `mechanical_paths` is configured.
export function needsFileList(aiReview) {
  return aiReview.mechanicalPaths !== null;
}

// "Mechanical" = small, and (when `mechanical_paths` is configured) touching
// only paths on that list. Without a file list we can't confirm the paths, so
// a configured pattern list makes the PR non-mechanical by default.
export function isMechanicalPr({ pr, aiReview, files = null }) {
  const diffSize = (pr.additions ?? 0) + (pr.deletions ?? 0);
  if (diffSize > aiReview.mechanicalMaxDiffSize) return false;
  if (!needsFileList(aiReview)) return true;
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((file) =>
    matchesFilterPatterns(aiReview.mechanicalPaths, file?.filename ?? file)
  );
}

export function resolveTier({ mechanical, hasExistingReview, aiReview }) {
  if (hasExistingReview && aiReview.topUpLite) return TIER.Lite;
  return mechanical ? TIER.Lite : TIER.Expensive;
}

const copilotSupports = (aiReview, effort) => aiReview.copilotEfforts.has(effort);

// Resolve a tier to a concrete { provider, effort } choice, or null when no
// enabled provider can serve it. Lite prefers Copilot; expensive picks at
// random from Auggie and (only if the default effort is Balanced) Copilot.
export function chooseReviewer({ tier, config, random = Math.random }) {
  const { aiReview } = config;
  const copilotEnabled = config.isProviderEnabled(BOT.Copilot);
  const augmentEnabled = config.isProviderEnabled(BOT.Augment);

  if (tier === TIER.Lite && copilotEnabled && copilotSupports(aiReview, EFFORT.Lite)) {
    return { provider: BOT.Copilot, effort: EFFORT.Lite };
  }

  const candidates = [];
  if (augmentEnabled) candidates.push({ provider: BOT.Augment, effort: null });
  if (copilotEnabled && copilotSupports(aiReview, EFFORT.Balanced)) {
    candidates.push({ provider: BOT.Copilot, effort: EFFORT.Balanced });
  }

  // Nothing in the intended tier — fall back to whatever is enabled rather
  // than silently skipping the review.
  if (candidates.length === 0) {
    if (copilotEnabled) return { provider: BOT.Copilot, effort: [...aiReview.copilotEfforts][0] ?? null };
    return null;
  }

  return candidates[Math.floor(random() * candidates.length)];
}

const TRIGGERS = {
  [BOT.Augment]: triggerAugmentReviewer,
  [BOT.Copilot]: triggerCopilotReviewer,
};

export async function triggerChoice(octokit, { owner, repo, issue_number, choice }) {
  const trigger = choice && TRIGGERS[choice.provider];
  if (!trigger) return;
  await trigger(octokit, { owner, repo, issue_number, effort: choice.effort });
}

export function reviewerLabel({ provider, effort }) {
  const name = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
  return effort ? `${name} (${effort === EFFORT.Lite ? "Lite" : "Balanced"})` : name;
}

// A choice is "expensive" when it isn't a Lite Copilot review.
export function isExpensiveChoice(choice) {
  return Boolean(choice) && choice.effort !== EFFORT.Lite;
}

const NOTICE_MARKER = "<!-- he-review-expensive-on-small -->";

export function expensiveOnSmallPrNotice({ choice, pr }) {
  const diffSize = (pr.additions ?? 0) + (pr.deletions ?? 0);
  return [
    NOTICE_MARKER,
    `ℹ️ Running **${reviewerLabel(choice)}** on a ${diffSize}-line mechanical change.`,
    "",
    "Deep reviews are our expensive ones — **Copilot (Lite)** (comment `ai review`)",
    "is usually enough for changes this size. Carry on if you wanted the extra scrutiny.",
  ].join("\n");
}
