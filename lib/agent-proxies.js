// Forwards pull-request activity to autonomous "agent" proxies. An agent runs
// somewhere else (its own repo/workflow) and opens PRs under its own bot
// identity; this module notices activity that agent cares about — reviews and
// comments on its PRs, @-mentions anywhere, settled checks on its PRs — and
// pokes it via a workflow_dispatch so it can respond.
//
// The app knows nothing about any specific agent. Every identity, trigger, and
// dispatch target comes from the `agents` block in .github/healthengine-review.yml
// (see config.js and normalizeAgents). With no agents configured, nothing here
// fires — the feature is dormant.

import { isBotUser } from "./ai-reviewers.js";
import { loadAiReviewConfig } from "./config.js";

// Longest a forwarded comment/review body is allowed to be. GitHub caps
// workflow_dispatch inputs at 65,535 characters total; leave headroom for the
// other inputs.
const MAX_BODY = 60000;

// Coalesce a burst of events on the same (agent, repo, pr, kind) into a single
// dispatch: a reviewer leaving five line comments, or CI re-reporting a status,
// should wake the agent once. Module-level so it survives across deliveries.
const pending = new Map();

const lc = (value) => (value ?? "").toLowerCase();

// --- Pure classifiers (no IO) — the routing rules, tested directly. ---------

// A formal review on the agent's own PR, from anyone but the agent itself.
// Humans AND bots count (AI reviewers are exactly the feedback worth acting
// on); approvals carry nothing to address.
export function classifyReview(agent, { prAuthor, reviewAuthor, state }) {
  if (!agent.events.has("review")) return null;
  if (lc(prAuthor) !== agent.botLower) return null;
  if (lc(reviewAuthor) === agent.botLower) return null;
  if (state === "approved") return null;
  return "review";
}

// A PR comment. On the agent's own PR it's feedback ("comment"); anywhere else
// it only counts if it @-mentions the agent ("mention"). Humans only — bots
// post screenshots and other no-op noise, and `ignore_users` covers service
// accounts that look like humans.
export function classifyComment(agent, { prAuthor, commentAuthor, isBot, body }) {
  if (isBot) return null;
  const author = lc(commentAuthor);
  if (author === agent.botLower) return null;
  if (agent.ignoreUsers.has(author)) return null;
  if (lc(prAuthor) === agent.botLower && agent.events.has("comment")) return "comment";
  if (agent.events.has("mention") && agent.mention?.test(body ?? "")) return "mention";
  return null;
}

// A settled commit status whose context the agent watches (e.g. buildkite/*).
// Pending is skipped — the agent only cares once the check has an outcome.
// The PR-ownership check happens in the handler, once the PR is resolved.
export function classifyStatus(agent, { state, context }) {
  if (!agent.events.has("check")) return null;
  if (state === "pending") return null;
  if (!agent.checks?.test(context ?? "")) return null;
  return "check";
}

// --- Dispatch ---------------------------------------------------------------

function scheduleDispatch(octokit, agent, { event, repo, pr, actor, body }) {
  const key = `${agent.name}:${repo}#${pr}:${event}`;
  clearTimeout(pending.get(key));
  const timer = setTimeout(() => {
    pending.delete(key);
    octokit.rest.actions
      .createWorkflowDispatch({
        owner: agent.dispatch.owner,
        repo: agent.dispatch.repo,
        workflow_id: agent.dispatch.workflow,
        ref: agent.dispatch.ref,
        inputs: {
          event,
          repo,
          pr: String(pr),
          actor: actor || "system",
          body: (body ?? "").slice(0, MAX_BODY),
        },
      })
      .catch((err) => {
        // Fail soft: a missing workflow or permission must never break review.
        console.error(`[agent-proxies] dispatch failed for ${key}:`, err.status ?? err.message);
      });
  }, agent.debounceMs);
  // Don't let a pending debounce keep the process alive.
  timer.unref?.();
  pending.set(key, timer);
}

// --- Handlers ---------------------------------------------------------------

export function register(app) {
  app.on("pull_request_review.submitted", async (context) => {
    const { agents } = await loadAiReviewConfig(context);
    if (!agents.length) return;
    const { pull_request: pr, review, repository } = context.payload;
    for (const agent of agents) {
      const kind = classifyReview(agent, {
        prAuthor: pr.user?.login,
        reviewAuthor: review.user?.login,
        state: review.state,
      });
      if (!kind) continue;
      scheduleDispatch(context.octokit, agent, {
        event: kind, repo: repository.name, pr: pr.number,
        actor: review.user?.login, body: review.body,
      });
    }
  });

  app.on("issue_comment.created", async (context) => {
    const { agents } = await loadAiReviewConfig(context);
    if (!agents.length) return;
    const { issue, comment, repository } = context.payload;
    if (!issue.pull_request) return;
    const isBot = isBotUser(comment.user);
    for (const agent of agents) {
      const kind = classifyComment(agent, {
        prAuthor: issue.user?.login,
        commentAuthor: comment.user?.login,
        isBot, body: comment.body,
      });
      if (!kind) continue;
      scheduleDispatch(context.octokit, agent, {
        event: kind, repo: repository.name, pr: issue.number,
        actor: comment.user?.login, body: comment.body,
      });
    }
  });

  app.on("status", async (context) => {
    const { agents } = await loadAiReviewConfig(context);
    if (!agents.length) return;
    const { state, context: statusContext, sha, repository, sender } = context.payload;
    const watching = agents.filter((agent) =>
      classifyStatus(agent, { state, context: statusContext }),
    );
    if (!watching.length) return;

    const { owner } = context.repo();
    let prs;
    try {
      const res = await context.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner, repo: repository.name, commit_sha: sha,
      });
      prs = res.data ?? [];
    } catch (err) {
      console.error(`[agent-proxies] PR lookup failed for ${repository.name}@${sha}:`, err.status ?? err.message);
      return;
    }

    for (const agent of watching) {
      for (const pr of prs) {
        if (pr.state !== "open") continue;
        if (lc(pr.user?.login) !== agent.botLower) continue;
        scheduleDispatch(context.octokit, agent, {
          event: "check", repo: repository.name, pr: pr.number,
          actor: sender?.login || "ci", body: `${state}: ${statusContext}`,
        });
      }
    }
  });
}
