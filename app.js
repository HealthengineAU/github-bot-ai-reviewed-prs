import { register as registerAgentProxies } from "./lib/agent-proxies.js";
import { register as registerAIReviewCommitStatus } from "./lib/ai-review-commit-status.js";
import { register as registerAutoTriggerAiReview } from "./lib/auto-trigger-ai-review.js";
import { register as registerCleanAiReviewComments } from "./lib/clean-ai-review-comments.js";
import { register as registerTriggerAiReview } from "./lib/trigger-ai-review.js";

export default (app) => {
  registerAgentProxies(app);
  registerAIReviewCommitStatus(app);
  registerAutoTriggerAiReview(app);
  registerCleanAiReviewComments(app);
  registerTriggerAiReview(app);
};
