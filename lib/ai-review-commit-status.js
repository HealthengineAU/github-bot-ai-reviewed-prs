// Posts an "AI Review" commit status summarizing which bots reviewed the PR
// and how many inline comments they left, or if a review has been requested.
//
// Bot-authored PRs are additionally gated on human approvals
// (ai_review.bot_pr_human_approvers): the status stays pending until at
// least `min` humans approve, unless the bot author is in `exclude`.

import {
  BOT,
  SKIP_LABEL,
  detectPendingAiReviewRequests,
  getBotDisplayName,
  getBotKey,
  isAuggieCommandComment,
  isBotUser,
} from "./ai-reviewers.js";
import { loadAiReviewConfig } from "./config.js";

const COMMIT_STATUS_CONTEXT = "AI Review";
const DESCRIPTION_MAX_LENGTH = 140;
const UPDATE_DEBOUNCE_MS = 800;

const COMMENT_TYPE = {
  Failed: "Failed",
};

const BOT_COMMENTS = {
  [BOT.Augment]: {
    [COMMENT_TYPE.Failed]: /tokens to review|out of credits|unable to review/,
  },

  [BOT.Copilot]: {
    [COMMENT_TYPE.Failed]: /Copilot wasn't able|unable to review|premium request/,
  },
};

export function clampDescription(description) {
  if (description.length <= DESCRIPTION_MAX_LENGTH) {
    return description;
  }
  return `${description.slice(0, DESCRIPTION_MAX_LENGTH - 1)}…`;
}

export function classifyBot({
  userId,
  login,
  displayName,
  botKey,
  comments,
  feedback,
}) {
  const detector = botKey ? BOT_COMMENTS[botKey] : null;
  const lastBody = comments[comments.length - 1]?.body;

  const data = {
    userId,
    login,
    displayName,
    feedback,
  };

  if (detector?.[COMMENT_TYPE.Failed] && lastBody && detector[COMMENT_TYPE.Failed].test(lastBody)) {
    return { ...data, state: "failed" };
  }

  if (feedback.resolved === feedback.total) {
    return { ...data, state: "resolved" };
  }

  return { ...data, state: "unresolved" };
}

// Count humans whose review currently stands at APPROVED: for each human
// reviewer only their latest APPROVED / CHANGES_REQUESTED / DISMISSED review
// counts (COMMENTED never supersedes an approval, matching GitHub's own
// review-state semantics). Reviews arrive from listReviews in submission order.
export function countHumanApprovals(reviews) {
  const latestByUser = new Map();
  for (const review of reviews) {
    const user = review.user;
    if (!user || user.id == null || isBotUser(user)) continue;
    const state = review.state?.toUpperCase();
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED") continue;
    latestByUser.set(user.id, state);
  }

  let approvals = 0;
  for (const state of latestByUser.values()) {
    if (state === "APPROVED") approvals++;
  }
  return approvals;
}

export function formatBotEntry(entry) {
  if (entry.state === "requested-review") {
    return `Requested ${entry.displayName}`;
  }

  if (entry.state === "failed") {
    return `${entry.displayName} unable to review`;
  }

  const { resolved, total } = entry.feedback;

  if (entry.state === "unresolved") {
    return `Reviewed by ${entry.displayName} (${resolved}/${total} acknowledged)`;
  }

  const summary = total > 0 ? `${total} acknowledged` : "no feedback";

  return `✓ Reviewed by ${entry.displayName} (${summary})`;
}

// Coalesce bursts of webhook events (we sometimes see ~20 fire at once
// for the same PR) into a single trailing-edge update per PR.
const pendingUpdates = new Map();

function scheduleUpdateAIReviewStatus(context, args) {
  const key = `${args.owner}/${args.repo}#${args.pr.number}`;
  const existing = pendingUpdates.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    pendingUpdates.delete(key);
    updateAIReviewStatus(context, args).catch((err) => {
      console.error(`AI Review status update failed for ${key}`, err);
    });
  }, UPDATE_DEBOUNCE_MS);

  pendingUpdates.set(key, timer);
}

async function updateAIReviewStatus(context, { owner, repo, pr }) {
  const octokit = context.octokit;
  const pull_number = pr.number;
  const sha = pr.head.sha;

  if (pr.state === "closed") {
    return;
  }

  const hasSkipLabel = (pr.labels || []).some((label) => label.name === SKIP_LABEL);

  if (hasSkipLabel) {
    await octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state: "success",
      context: COMMIT_STATUS_CONTEXT,
      description: clampDescription(`Review skipped via "${SKIP_LABEL}" label`),
    });

    return;
  }

  const config = await loadAiReviewConfig(context);

  if (config.isAuthorSkipped(pr.user?.login)) {
    await octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state: "success",
      context: COMMIT_STATUS_CONTEXT,
      description: clampDescription(`AI review skipped for author ${pr.user.login}`),
    });

    return;
  }

  // Bot-authored PRs (ai_review.bot_pr_human_approvers) hold the status at
  // pending until enough humans have approved. Excluded bot authors and
  // min: 0 opt out; skip_authors above already won for its listed bots.
  const approverGate = config.aiReview.botPrHumanApprovers;
  const gateApplies =
    isBotUser(pr.user) &&
    approverGate.min > 0 &&
    !approverGate.exclude.has(pr.user?.login?.toLowerCase() ?? "");

  // get feedback
  const [reviews, issueComments, reviewComments, combinedStatus, threadsResult] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner, repo, pull_number, per_page: 50,
    }),
    octokit.paginate(octokit.rest.issues.listComments, {
      owner, repo, issue_number: pull_number, per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner, repo, pull_number, per_page: 100,
    }),
    octokit.rest.repos.getCombinedStatusForRef({
      owner, repo, ref: sha,
    }),
    octokit.graphql(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                isOutdated
                comments(first: 1) { totalCount nodes { databaseId } }
              }
            }
          }
        }
      }`,
      { owner, repo, number: pull_number },
    ),
  ]);

  const humanApprovals = gateApplies ? countHumanApprovals(reviews) : 0;

  if (gateApplies && humanApprovals < approverGate.min) {
    const noun = approverGate.min === 1 ? "approval" : "approvals";
    await octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state: "pending",
      context: COMMIT_STATUS_CONTEXT,
      description: clampDescription(
        `Bot authored PR requires ${approverGate.min} ${noun} (${humanApprovals}/${approverGate.min})`,
      ),
    });

    return;
  }

  const reviewThreads = threadsResult?.repository?.pullRequest?.reviewThreads?.nodes || [];
  const reviewCommentsById = new Map(reviewComments.map((c) => [c.id, c]));

  // Group threads by the originating inline comment's author user.id.
  // Match by user.id, not login: Copilot's review user is "copilot-pull-request-reviewer[bot]"
  // but its inline comments are authored as "Copilot" — same id, different login.
  const threadsByAuthorId = new Map();
  for (const thread of reviewThreads) {
    const firstId = thread.comments?.nodes?.[0]?.databaseId;
    const userId = firstId != null ? reviewCommentsById.get(firstId)?.user?.id : null;
    if (userId == null) continue;
    const list = threadsByAuthorId.get(userId) || [];
    list.push(thread);
    threadsByAuthorId.set(userId, list);
  }

  // Bots qualify as reviewers only if they submitted a formal review.
  // Issue comments enrich the per-bot timeline so last-comment detectors fire correctly.
  const botActivity = new Map();
  for (const review of reviews) {
    if (!isBotUser(review.user) || review.user?.id == null) continue;
    const entry = botActivity.get(review.user.id) || { user: review.user, comments: [] };
    if (review.body) {
      entry.comments.push({ body: review.body, createdAt: review.submitted_at, url: review.html_url });
    }
    botActivity.set(review.user.id, entry);
  }
  for (const comment of issueComments) {
    if (!isBotUser(comment.user) || comment.user?.id == null) continue;
    const entry = botActivity.get(comment.user.id);
    if (!entry || !comment.body) continue;
    entry.comments.push({ body: comment.body, createdAt: comment.created_at, url: comment.html_url });
  }
  for (const entry of botActivity.values()) {
    entry.comments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  const classifications = [];
  for (const [userId, entry] of botActivity) {
    const login = entry.user?.login;
    const threads = threadsByAuthorId.get(userId) || [];

    const resolvedThreads = threads.filter((thread) =>
      thread.isResolved // explicitly marked as resolved
      || thread.isOutdated // the referenced code has since been modified
      || (thread.comments?.totalCount || 0) > 1 // thread has ANY replies
    );

    classifications.push(classifyBot({
      userId,
      login,
      displayName: getBotDisplayName(login),
      botKey: getBotKey(login),
      comments: entry.comments,
      feedback: {
        total: threads.length,
        resolved: resolvedThreads.length,
      },
    }));
  }

  // Requested-but-not-delivered reviews (a requested Copilot, an Auggie
  // summon in flight, an AI-review team request). A bot that already has a
  // classification wins over its own re-request, matching the previous
  // requested_reviewers behavior.
  const classifiedUserIds = new Set(classifications.map((cl) => cl.userId));
  const classifiedProviders = new Set(
    classifications.map((cl) => getBotKey(cl.login)).filter(Boolean)
  );
  const pendingReviewClassifications = detectPendingAiReviewRequests({
    pr,
    issueComments,
    reviews,
    statuses: combinedStatus?.data?.statuses || [],
    augmentEnabled: config.isProviderEnabled(BOT.Augment),
    linearbEnabled: config.isProviderEnabled(BOT.LinearB),
  })
    .filter((request) =>
      !(request.userId != null && classifiedUserIds.has(request.userId))
      && !(request.provider != null && classifiedProviders.has(request.provider)))
    .map((request) => ({
      state: "requested-review",
      userId: request.userId ?? null,
      login: request.login ?? null,
      displayName: request.displayName,
      comments: [],
      feedback: {
        total: 0,
        resolved: 0,
      },
    }));
  classifications.push(...pendingReviewClassifications);
  classifications.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const parts = classifications.map(formatBotEntry);

  let description;
  if (parts.length > 0) {
    // Sentence case
    const joined = parts.join(", ");
    description = joined.charAt(0).toUpperCase() + joined.slice(1);
  } else if (gateApplies) {
    // The gate held this status at pending — flip it green once satisfied,
    // even when no AI reviewer has touched the PR.
    const noun = humanApprovals === 1 ? "approval" : "approvals";
    description = `✓ Bot authored PR has ${humanApprovals} human ${noun}`;
  } else {
    return;
  }

  let latestComment = null;
  for (const entry of botActivity.values()) {
    const last = entry.comments[entry.comments.length - 1];
    if (last && (!latestComment || new Date(last.createdAt) > new Date(latestComment.createdAt))) {
      latestComment = last;
    }
  }

  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state: "success",
    context: COMMIT_STATUS_CONTEXT,
    description: clampDescription(description),
    target_url: latestComment?.url ?? null,
  });
}

export function register(app) {
  app.on([
    "pull_request.opened",
    "pull_request.ready_for_review",
    "pull_request.reopened",
    "pull_request.review_requested",
    "pull_request.synchronize",
  ], async (context) => {
    const { owner, repo } = context.repo();
    const pr = context.payload.pull_request;

    scheduleUpdateAIReviewStatus(context, { owner, repo, pr });
  });

  app.on([
    "pull_request_review.submitted",
    "pull_request_review.dismissed",
  ], async (context) => {
    const { pull_request: pr, review } = context.payload;

    // Bot reviews change the AI-review picture; human reviews (and dismissals)
    // on bot-authored PRs move the bot_pr_human_approvers gate.
    if (!isBotUser(review.user) && !isBotUser(pr.user)) {
      return;
    }

    const { owner, repo } = context.repo();

    scheduleUpdateAIReviewStatus(context, { owner, repo, pr });
  });

  app.on([
    "pull_request_review_thread.resolved",
    "pull_request_review_thread.unresolved",
  ], async (context) => {
    const { pull_request: pr, thread } = context.payload;

    const firstComment = thread.comments[0];

    if (!firstComment || !isBotUser(firstComment.user)) {
      return;
    }

    const { owner, repo } = context.repo();

    scheduleUpdateAIReviewStatus(context, { owner, repo, pr });
  });

  app.on([
    "pull_request_review_comment.created",
  ], async (context) => {
    const { pull_request: pr, comment } = context.payload;

    // a bot review comment OR any reply to any thread (no filter)
    if (isBotUser(comment.user) || comment.in_reply_to_id != null) {
      const { owner, repo } = context.repo();

      scheduleUpdateAIReviewStatus(context, { owner, repo, pr });
    }
  });

  app.on([
    "pull_request.labeled",
  ], async (context) => {
    if (context.payload.label?.name !== SKIP_LABEL) {
      return;
    }

    const { owner, repo } = context.repo();
    const pr = context.payload.pull_request;

    scheduleUpdateAIReviewStatus(context, { owner, repo, pr });
  });

  app.on([
    "pull_request.unlabeled",
  ], async (context) => {
    if (context.payload.label?.name !== SKIP_LABEL) {
      return;
    }

    const pr = context.payload.pull_request;
    const sha = pr.head.sha;
    const { owner, repo } = context.repo();

    // when label is just removed, we revert the check to
    // "pending" first so that the gate is reinstated
    await context.octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state: "pending",
      context: COMMIT_STATUS_CONTEXT,
      description: clampDescription(`"${SKIP_LABEL}" label removed`),
    });

    scheduleUpdateAIReviewStatus(context, { owner, repo, pr });
  });

  app.on([
    "issue_comment.created",
  ], async (context) => {
    const { issue, comment } = context.payload;
    if (!issue.pull_request) {
      return;
    }

    // Bot comments (a review arriving, our own summon) and human-typed Auggie
    // summon commands both change the requested/reviewed picture. The summon
    // command is the one request path with no follow-up webhook of its own.
    if (!isBotUser(comment.user) && !isAuggieCommandComment(comment.body)) {
      return;
    }

    const { owner, repo } = context.repo();
    const { data: pr } = await context.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: issue.number,
    });

    scheduleUpdateAIReviewStatus(context, { owner, repo, pr });
  });
}
