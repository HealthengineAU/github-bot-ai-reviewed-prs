// Automatically invites a random enabled AI reviewer when a pull request
// enters the ready state (opened, marked ready for review, or reopened) and
// no AI review has been completed or requested yet.
//
// OPT-IN: nothing fires unless `ai_review.automatic: true` is set in
// .github/healthengine-review.yml. That section also controls whether drafts
// are included, the eligible target branches/repos/authors, and the diff-size
// bounds (see config.js).

import {
  BOT,
  SKIP_LABEL,
  canSummonReviewer,
  detectPendingAiReviewRequests,
  hasCompletedAiReview,
  triggerRandomReviewer,
} from "./ai-reviewers.js";
import { loadAiReviewConfig } from "./config.js";
import { matchesFilterPatterns } from "./filter-patterns.js";

// The pending/completed evaluation is deferred so competing review signals can
// land first.
const EVALUATE_DELAY_MS = 5_000;

// The config gate: the automatic opt-in, the draft policy, repo/base-branch/
// author pattern filters (GitHub-Actions-style, see filter-patterns.js), and
// diff-size bounds (inclusive, additions + deletions).
export function isAutoReviewEligible({ aiReview, repo, pr }) {
  if (!aiReview.automatic) return false;
  if (pr.draft && !aiReview.includeDrafts) return false;
  if (!matchesFilterPatterns(aiReview.repositories, repo)) return false;
  if (!matchesFilterPatterns(aiReview.branches, pr.base?.ref ?? "")) return false;
  if (!matchesFilterPatterns(aiReview.authors, pr.user?.login ?? "")) return false;

  const diffSize = (pr.additions ?? 0) + (pr.deletions ?? 0);
  return diffSize >= aiReview.minDiffSize && diffSize <= aiReview.maxDiffSize;
}

// Anything already reviewed or in flight (a requested Copilot, an Auggie
// summon, an AI-review team request, a gitStream/LinearB run) means no
// automatic invite.
async function evaluateAndSummon(context, { owner, repo, pr, config }) {
  const pull_number = pr.number;
  const [reviews, issueComments, combinedStatus] = await Promise.all([
    context.octokit.paginate(context.octokit.rest.pulls.listReviews, {
      owner, repo, pull_number, per_page: 50,
    }),
    context.octokit.paginate(context.octokit.rest.issues.listComments, {
      owner, repo, issue_number: pull_number, per_page: 100,
    }),
    context.octokit.rest.repos.getCombinedStatusForRef({
      owner, repo, ref: pr.head.sha,
    }),
  ]);

  if (hasCompletedAiReview(reviews)) return;

  const pendingRequests = detectPendingAiReviewRequests({
    pr,
    issueComments,
    reviews,
    statuses: combinedStatus?.data?.statuses || [],
    augmentEnabled: config.isProviderEnabled(BOT.Augment),
    linearbEnabled: config.isProviderEnabled(BOT.LinearB),
  });
  if (pendingRequests.length > 0) return;

  await triggerRandomReviewer(context.octokit, {
    owner,
    repo,
    issue_number: pull_number,
    config,
  });
}

export function register(app) {
  app.on([
    "pull_request.opened",
    "pull_request.ready_for_review",
    "pull_request.reopened",
  ], async (context) => {
    const pr = context.payload.pull_request;

    if ((pr.labels || []).some((label) => label.name === SKIP_LABEL)) return;

    const { owner, repo } = context.repo();
    const config = await loadAiReviewConfig(context);

    // Skip-listed authors (ai_review.skip_authors, default dependabot[bot])
    // are skipped just like the commit status skips them. Drafts are a config
    // decision (ai_review.include_drafts), checked in isAutoReviewEligible;
    // by default they get their invite once ready.
    if (config.isAuthorSkipped(pr.user?.login)) return;

    // No summonable reviewer enabled → the summon would no-op, so don't spend
    // the evaluation fetches on it.
    if (!canSummonReviewer(config)) return;

    if (!isAutoReviewEligible({ aiReview: config.aiReview, repo, pr })) {
      return;
    }

    // Fire-and-forget: webhook deliveries time out after ~10s, so the handler
    // must not stay open for the evaluation delay.
    setTimeout(() => {
      evaluateAndSummon(context, { owner, repo, pr, config }).catch((err) => {
        console.error(`Auto AI review invite failed for ${owner}/${repo}#${pr.number}`, err);
      });
    }, EVALUATE_DELAY_MS);
  });
}
