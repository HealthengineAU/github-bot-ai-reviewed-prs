// Manual AI-review triggers. Lets team members summon a review with a bit of
// personality: commenting "roast me, auggie" (or any comment mentioning both
// "roast me" and "auggie") makes the bot reply with the literal `auggie review`
// trigger. Also handles the `ai-review` label and AI-review team requests.
//
// Reviewer identity and the actual summoning live in ai-reviewers.js.

import {
  AI_REVIEW_TEAM,
  AUGGIE_REVIEW_TEAM,
  AUGMENTCODE_BOT_LOGIN,
  PROVIDER_DISPLAY_NAMES,
  getProviderGroupSize,
  isBotUser,
  triggerAugmentReviewer,
  triggerCopilotReviewer,
  triggerRandomReviewer,
} from "./ai-reviewers.js";
import { loadAiReviewConfig } from "./config.js";

// Any of these phrases anywhere in the comment summons a review.
export const TRIGGER_AUGMENT_PHRASES = /roast me.*auggie|auggie please/i;
export const TRIGGER_COPILOT_PHRASES = /roast me.*copilot|copilot please|copilot review/i;
export const TRIGGER_RANDOM_PHRASES = /^\s*`*\s*ai review\s*`*\s*$|random ai review/i;

// Adding this label to a PR also summons a review; it's removed once handled.
export const TRIGGER_LABEL = /ai[\s-]review/i;
export const SKIP_TRIGGER_LABEL = /no|skip/i;

// Don't fire if the comment is already an Augment/Augment-review trigger —
// no point summoning a review that's already being requested.
export const ALREADY_TRIGGERING_AUGMENT_PHRASES = /auggie review|augment review|augmentcode review/i;

// Tell the requester a provider they explicitly summoned isn't enabled here.
async function notifyProviderDisabled(
  octokit,
  { owner, repo, issue_number, provider, config }
) {
  const name = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
  const currentProviderList = [...config.providers].map(p => ` - ${PROVIDER_DISPLAY_NAMES[p] ?? p}`).join("\n");
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number,
    body: `**${name}** is not currently available. Active providers ([source](https://github.com/${owner}/.github/blob/main/.github/healthengine-review.yml)) are:\n${currentProviderList || "- _None available!_"}`,
  });
}

export function register(app) {
  app.on(["issue_comment.created"], async (context) => {
    const { issue, comment } = context.payload;

    // Only on pull requests, and never react to our own/other bots' comments.
    if (!issue.pull_request) return;
    if (isBotUser(comment.user)) return;

    const { owner, repo } = context.repo();
    const { body } = comment;

    if (!body) return;
    if (ALREADY_TRIGGERING_AUGMENT_PHRASES.test(body)) return;

    const config = await loadAiReviewConfig(context);

    // An explicitly-summoned provider that isn't enabled here, or the random
    // pool when only generic phrases are used.
    let explicitProvider = null;
    let triggerReviewFn = null;

    if (TRIGGER_COPILOT_PHRASES.test(body)) {
      explicitProvider = "copilot";
      triggerReviewFn = triggerCopilotReviewer;
    } else if (TRIGGER_AUGMENT_PHRASES.test(body)) {
      explicitProvider = "augment";
      triggerReviewFn = triggerAugmentReviewer;
    } else if (TRIGGER_RANDOM_PHRASES.test(body)) {
      triggerReviewFn = triggerRandomReviewer;
    }

    if (!triggerReviewFn) return;

    if (explicitProvider && !config.isProviderEnabled(explicitProvider)) {
      await notifyProviderDisabled(context.octokit, {
        owner,
        repo,
        issue_number: issue.number,
        provider: explicitProvider,
        config,
      });

      // Acknowledge with 👎
      await context.octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: comment.id,
        content: "-1",
      });

      return;
    }

    // Acknowledge with 👍
    await context.octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: comment.id,
      content: "+1",
    });

    await triggerReviewFn(context.octokit, {
      owner,
      repo,
      issue_number: issue.number,
      config,
    });
  });

  app.on(["pull_request.labeled"], async (context) => {
    const { pull_request, label } = context.payload;

    const name = label?.name ?? "";

    if (!TRIGGER_LABEL.test(name) || SKIP_TRIGGER_LABEL.test(name)) {
      return;
    }

    const { owner, repo } = context.repo();

    // Remove the label so re-adding it can summon another review.
    await context.octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: pull_request.number,
      name,
    });

    const config = await loadAiReviewConfig(context);

    await triggerRandomReviewer(context.octokit, {
      owner,
      repo,
      issue_number: pull_request.number,
      config,
      bandSize: getProviderGroupSize(pull_request, config.aiReview),
    });
  });

  app.on(["pull_request.review_requested"], async (context) => {
    const { pull_request, requested_team } = context.payload;

    if (!requested_team) {
      return;
    }

    const { owner, repo } = context.repo();

    const isAuggieRequested = AUGGIE_REVIEW_TEAM.test(requested_team.slug) || AUGGIE_REVIEW_TEAM.test(requested_team.name)
    const isAnyAIRequested = AI_REVIEW_TEAM.test(requested_team.slug) || AI_REVIEW_TEAM.test(requested_team.name);

    if (!isAuggieRequested && !isAnyAIRequested) {
      return;
    }

    const config = await loadAiReviewConfig(context);

    if (isAuggieRequested) {
      if (!config.isProviderEnabled("augment")) {
        // Auggie isn't enabled here: don't summon, but still clear the bogus
        // team request so it doesn't sit as a pending reviewer, and explain why.
        try {
          await context.octokit.pulls.removeRequestedReviewers({
            ...context.pullRequest(),
            reviewers: [],
            team_reviewers: [requested_team.slug],
          });
        } catch {
          // swallow errors
        }

        await notifyProviderDisabled(context.octokit, {
          owner,
          repo,
          issue_number: pull_request.number,
          provider: "augment",
          config,
        });

        return;
      }

      // Explicitly summoning Auggie: trigger the review but leave the team
      // request in place. It's removed later
      await triggerAugmentReviewer(context.octokit, {
        owner,
        repo,
        issue_number: pull_request.number,
      });

      return;
    }

    try {
      await context.octokit.pulls.removeRequestedReviewers({
        ...context.pullRequest(),
        reviewers: [],
        team_reviewers: [requested_team.slug],
      });
    } catch {
      // swallow errors
    }

    await triggerRandomReviewer(context.octokit, {
      owner,
      repo,
      issue_number: pull_request.number,
      config,
      bandSize: getProviderGroupSize(pull_request, config.aiReview),
    });
  });

  app.on(["pull_request_review.submitted"], async (context) => {
    const { pull_request, review } = context.payload;

    if (!AUGMENTCODE_BOT_LOGIN.test(review.user?.login ?? "")) {
      return;
    }

    const teamSlugs = pull_request.requested_teams.map((team) => team.slug);
    const auggieTeamSlugs = teamSlugs.filter((teamSlug) => AUGGIE_REVIEW_TEAM.test(teamSlug));

    if (auggieTeamSlugs.length > 0) {
      try {
        await context.octokit.pulls.removeRequestedReviewers({
            ...context.pullRequest(),
          reviewers: [],
          team_reviewers: auggieTeamSlugs,
        });
      } catch {
        // swallow errors
      }
    }
  });
}
