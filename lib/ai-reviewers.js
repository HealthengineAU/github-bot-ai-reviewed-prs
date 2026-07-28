// Shared AI-reviewer knowledge: which providers exist, how to recognise them
// in GitHub data (logins, teams, markers), how to summon them, and how to
// detect pending/completed AI review activity on a pull request.
//
// Used by the manual triggers (trigger-ai-review.js), the automatic trigger
// (auto-trigger-ai-review.js), and the commit status (ai-review-commit-status.js).

/** Provider values MUST be matching substrings of github.login.toLowerCase() */
export const BOT = {
  Augment: "augment",
  Claude: "claude",
  Copilot: "copilot",
  Greptile: "greptile",
  LinearB: "linearb",
};

// Friendly display names for the providers we know about.
export const PROVIDER_DISPLAY_NAMES = {
  [BOT.Augment]: "Auggie",
  [BOT.Claude]: "Claude",
  [BOT.Copilot]: "Copilot",
  [BOT.Greptile]: "Greptile",
  [BOT.LinearB]: "LinearB",
};

// Display names for specific bot logins (exact match, unlike the provider
// substring matching above). An entry here does not make a login count as an
// AI-review provider.
export const BOT_LOGIN_DISPLAY_NAMES = {
  "dusty-the-robot[bot]": "Dusty",
};

// Adding this label to a PR skips the AI review entirely: the commit status
// short-circuits to success and the automatic trigger stays quiet.
export const SKIP_LABEL = "skip-ai-review";

// Requesting a review from a team whose slug or display name contains
// "ai-review" / "AI Review" summons a (random) review; a team containing
// "auggie" summons Auggie specifically.
export const AI_REVIEW_TEAM = /ai[\s-]review/i;
export const AUGGIE_REVIEW_TEAM = /auggie/i;

// GitHub's Copilot code-review bot, requested like any other reviewer.
export const COPILOT_REVIEWER_LOGIN = "copilot-pull-request-reviewer[bot]";

// Auggie shows up under this login once its review comes back.
export const AUGMENTCODE_BOT_LOGIN = /augmentcode/i;

// LinearB reviews arrive via gitStream, which reports its automation run as a
// "gitStream.cm" commit status. That status being present and not failing
// means a run (and the LinearB review it delivers) is in flight or done.
export const GITSTREAM_STATUS_CONTEXT = /gitstream/i;

// Auggie tags its summary comment with this marker; including it in our summon
// reply makes Auggie post its summary in the same block to reduce noise.
export const AUGMENT_SUMMARY_MARKER = "<!-- augment-pr-summary -->";

// While a review is in progress, the comment also carries this marker. Editing
// a comment in this state breaks Auggie, so we leave pending comments untouched.
export const AUGMENT_PENDING_MARKER = "<!-- augment-pending -->";

const AUGMENT_SUMMON_REPLY = "auggie review";
const AUGMENT_SUMMON_REPLY_EDIT = `${AUGMENT_SUMMARY_MARKER}\n${AUGMENT_PENDING_MARKER}\n**{•<sup><sup>"</sup></sup>•}** Summoning auggie review...`;
const AUGMENT_SUMMON_REPLY_FAILED = `${AUGMENT_SUMMARY_MARKER}\n**{•<sup><sup>"</sup></sup>•}** Hmm... If Auggie still hasn't acknowledged, try commenting \`auggie review\` manually`;

export function isBotUser(user) {
  return user?.type === "Bot" || user?.login?.endsWith("[bot]");
}

export function getBotKey(login) {
  const lower = login?.toLowerCase();
  if (!lower) return null;
  for (const key of Object.values(BOT)) {
    if (lower.includes(key)) return key;
  }
  return null;
}

export function getBotDisplayName(login) {
  const exact = BOT_LOGIN_DISPLAY_NAMES[login?.toLowerCase()];
  if (exact) return exact;

  for (const pattern in PROVIDER_DISPLAY_NAMES) {
    if (login?.toLowerCase().includes(pattern)) {
      return PROVIDER_DISPLAY_NAMES[pattern];
    }
  }

  return login;
}

// ---------------------------------------------------------------------------
// Summoning
// ---------------------------------------------------------------------------

export async function triggerAugmentReviewer(octokit, { owner, repo, issue_number }) {
  // Look for an existing Augment summary block on this PR.
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
  });
  const summaries = comments.filter((c) =>
    c.body?.includes(AUGMENT_SUMMARY_MARKER)
  );

  // A review is already in progress — don't summon another (and don't touch
  // the pending comment, since editing it breaks Auggie).
  if (summaries.some((c) => c.body.includes(AUGMENT_PENDING_MARKER))) {
    return;
  }

  // Any remaining summaries are from a completed review. Strip their marker so
  // the new summon block becomes the one Auggie posts its next summary into.
  for (const summary of summaries) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: summary.id,
      body: summary.body.replace(AUGMENT_SUMMARY_MARKER, ""),
    });
  }

  // We inject the summon into the request comment
  const SUMMON_COMMENT_INJECT_MARKERS_MS = 10_000;
  const CHECK_AUGGIE_REQUEST_FAILED_MS = 20_000;
  const summonComment = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number,
    body: AUGMENT_SUMMON_REPLY,
  });

  // update a few seconds later with the MARKERS comment
  setTimeout(() => {
    octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: summonComment.data.id,
      body: AUGMENT_SUMMON_REPLY_EDIT,
    }).catch((err) => {
      console.error(`Augment summon marker edit failed for ${owner}/${repo}#${issue_number}`, err);
    });
  }, SUMMON_COMMENT_INJECT_MARKERS_MS);

  // Check whether Auggie has acknowledged the summon by reacting.
  // If no react, then update the body to say it failed.
  setTimeout(() => {
    (async () => {
      const reactions = await octokit.paginate(
        octokit.rest.reactions.listForIssueComment,
        {
          owner,
          repo,
          comment_id: summonComment.data.id,
        }
      );

      const auggieReacted = reactions.some((r) =>
        AUGMENTCODE_BOT_LOGIN.test(r.user?.login ?? "")
      );

      if (!auggieReacted) {
        await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: summonComment.data.id,
          body: AUGMENT_SUMMON_REPLY_FAILED,
        });
      }
    })().catch((err) => {
      console.error(`Augment summon acknowledgement check failed for ${owner}/${repo}#${issue_number}`, err);
    });
  }, CHECK_AUGGIE_REQUEST_FAILED_MS);
}

export async function triggerCopilotReviewer(octokit, { owner, repo, issue_number }) {
  await octokit.rest.pulls.requestReviewers({
    owner,
    repo,
    pull_number: issue_number,
    reviewers: [COPILOT_REVIEWER_LOGIN],
  });
}

const AI_REVIEWER_TRIGGERS = [
  { provider: BOT.Augment, trigger: triggerAugmentReviewer },
  { provider: BOT.Copilot, trigger: triggerCopilotReviewer },
];

// True when at least one summonable reviewer (Auggie, Copilot) is enabled —
// lets callers skip work that would end in a triggerRandomReviewer no-op.
export function canSummonReviewer(config) {
  return AI_REVIEWER_TRIGGERS.some((t) => config.isProviderEnabled(t.provider));
}

// Summon one of the enabled AI reviewers at random (Auggie or Copilot).
export async function triggerRandomReviewer(octokit, { owner, repo, issue_number, config }) {
  const enabled = AI_REVIEWER_TRIGGERS.filter((t) => config.isProviderEnabled(t.provider));
  if (enabled.length === 0) {
    return;
  }
  const index = Math.floor(Math.random() * enabled.length);
  await enabled[index].trigger(octokit, { owner, repo, issue_number });
}

// ---------------------------------------------------------------------------
// Request/review state detection
// ---------------------------------------------------------------------------

// A comment whose entire body is an Auggie summon command ("auggie review",
// "augment review", "augmentcode review", optionally backticked). Exact-body
// on purpose: the summon-failed reply merely *mentions* `auggie review` and
// must not read as a live request.
const AUGGIE_COMMAND_COMMENT = /^\s*`*\s*(?:auggie|augment|augmentcode) review\s*`*\s*$/i;

export function isAuggieCommandComment(body) {
  return typeof body === "string" && AUGGIE_COMMAND_COMMENT.test(body);
}

// An Auggie summon is live when a comment still carries the pending marker, or
// a summon command has no Augment activity (review or comment) after it. Our
// own summon comment is the literal command for its first few seconds, then
// carries the pending marker, and ends up as either the summary or the
// summon-failed reply — none of which read as pending. A human's `auggie
// review` command stays as-is, so it reads as pending until Auggie responds.
export function hasPendingAuggieSummon({ issueComments = [], reviews = [] }) {
  let lastCommandAt = null;
  for (const comment of issueComments) {
    if (comment.body?.includes(AUGMENT_PENDING_MARKER)) return true;
    if (isAuggieCommandComment(comment.body)) {
      const at = new Date(comment.created_at ?? 0).getTime();
      if (lastCommandAt === null || at > lastCommandAt) lastCommandAt = at;
    }
  }
  if (lastCommandAt === null) return false;

  const augmentActivity = [
    ...reviews
      .filter((r) => AUGMENTCODE_BOT_LOGIN.test(r.user?.login ?? ""))
      .map((r) => r.submitted_at),
    ...issueComments
      .filter((c) => AUGMENTCODE_BOT_LOGIN.test(c.user?.login ?? ""))
      .map((c) => c.created_at),
  ];

  return !augmentActivity.some(
    (ts) => new Date(ts ?? 0).getTime() >= lastCommandAt
  );
}

// AI reviews that have been requested but not yet delivered, from data the
// caller has already fetched. `statuses` are the head sha's commit statuses
// (latest per context). Returns [{ provider, userId?, login?, displayName }]
// de-duped by provider/user; `provider` is null for a generic "AI review"
// team request that hasn't resolved to a specific reviewer yet.
export function detectPendingAiReviewRequests({
  pr,
  issueComments = [],
  reviews = [],
  statuses = [],
  augmentEnabled = true,
  linearbEnabled = true,
}) {
  const requests = [];
  const seen = new Set();

  const add = (request) => {
    const keys = [request.provider ?? request.displayName?.toLowerCase(), request.userId]
      .filter((key) => key != null);
    if (keys.some((key) => seen.has(key))) return;
    for (const key of keys) seen.add(key);
    requests.push(request);
  };

  // Bots sitting in requested_reviewers (Copilot is requested like a human).
  for (const user of pr.requested_reviewers || []) {
    if (!isBotUser(user)) continue;
    add({
      provider: getBotKey(user.login),
      userId: user.id,
      login: user.login,
      displayName: getBotDisplayName(user.login),
    });
  }

  // Team-based requests: an "auggie" team means Auggie; an "ai-review" team is
  // a generic request (it gets swapped for a concrete reviewer within seconds,
  // but can linger in the payload that triggered this update).
  for (const team of pr.requested_teams || []) {
    const slug = team?.slug ?? "";
    const name = team?.name ?? "";
    if (AUGGIE_REVIEW_TEAM.test(slug) || AUGGIE_REVIEW_TEAM.test(name)) {
      add({ provider: BOT.Augment, displayName: PROVIDER_DISPLAY_NAMES[BOT.Augment] });
    } else if (AI_REVIEW_TEAM.test(slug) || AI_REVIEW_TEAM.test(name)) {
      add({ provider: null, displayName: "AI review" });
    }
  }

  // Comment-based Auggie summons (ours or a human's typed command). Skipped
  // when Augment is disabled so a dangling command can't read as pending.
  if (augmentEnabled && hasPendingAuggieSummon({ issueComments, reviews })) {
    add({ provider: BOT.Augment, displayName: PROVIDER_DISPLAY_NAMES[BOT.Augment] });
  }

  // LinearB via gitStream: a present, non-failing gitStream.cm status means a
  // run is in flight (or done) and its review follows.
  if (linearbEnabled) {
    const gitstream = statuses.find((status) =>
      GITSTREAM_STATUS_CONTEXT.test(status?.context ?? "")
    );
    if (gitstream && gitstream.state !== "failure" && gitstream.state !== "error") {
      add({ provider: BOT.LinearB, displayName: PROVIDER_DISPLAY_NAMES[BOT.LinearB] });
    }
  }

  return requests;
}

// Any bot-submitted formal review counts as a completed AI review — the same
// rule the commit status uses to qualify a bot as a reviewer.
export function hasCompletedAiReview(reviews = []) {
  return reviews.some((review) => isBotUser(review.user));
}
