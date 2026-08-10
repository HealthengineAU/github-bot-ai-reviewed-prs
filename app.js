import { register as registerAgentProxies } from "./lib/agent-proxies.js";
import { register as registerAIReviewCommitStatus } from "./lib/ai-review-commit-status.js";
import { register as registerAutoTriggerAiReview } from "./lib/auto-trigger-ai-review.js";
import { register as registerCleanAiReviewComments } from "./lib/clean-ai-review-comments.js";
import { register as registerDustySlackProxy } from "./lib/dusty-slack-proxy.js";
import { register as registerTriggerAiReview } from "./lib/trigger-ai-review.js";

// Probot calls this with (app, { getRouter, cwd }) — getRouter is only present
// when running under the HTTP server, and is what mounts non-webhook routes.
export default (app, options = {}) => {
  registerAgentProxies(app);
  registerAIReviewCommitStatus(app);
  registerAutoTriggerAiReview(app);
  registerCleanAiReviewComments(app);
  registerDustySlackProxy(app, options);
  registerTriggerAiReview(app);
};
