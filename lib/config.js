// Loads the .github provider configuration for a repository.
//
// Resolution (handled by Probot's context.config / octokit-plugin-config):
//   1. .github/healthengine-review.yml in the PR's repo (default branch only)
//   2. else the org's `.github` repo
//   3. else DEFAULT_CONFIG below
// Config files may also use `_extends` to inherit from another repo.

import { BOT } from "./ai-reviewers.js";
import { compileFilterPatterns } from "./filter-patterns.js";

const CONFIG_FILE = "healthengine-review.yml";

// The providers we know about, from the shared reviewer identity module.
export const KNOWN_PROVIDERS = Object.values(BOT);

// No config anywhere → every provider is enabled (preserves prior behavior).
const DEFAULT_CONFIG = { providers: KNOWN_PROVIDERS };

const KNOWN_PROVIDER_SET = new Set(KNOWN_PROVIDERS);

// PR authors whose pull requests skip AI review entirely (exact logins,
// case-insensitive). Overridable via `ai_review.skip_authors` in the config
// file; an explicit empty list means "skip no one".
const DEFAULT_SKIP_AUTHORS = ["dependabot[bot]"];

// AI review settings (auto-trigger-ai-review.js). Automatic invites are
// OPT-IN: nothing fires unless the config sets `ai_review.automatic: true`.
// When on, they cover every repo and author, skip drafts, only target
// mainline branches, and cap at 2000 changed lines. The filter lists take
// GitHub-Actions-style patterns (see filter-patterns.js), e.g.
// repositories: ["*", "!legacy-monolith"]. Repo names and logins never
// contain "/", so "*" matches them all; branch patterns need "**" to span
// slashes (e.g. ["**", "!test/**"]).
const AI_REVIEW_DEFAULTS = {
  branches: ["master", "main", "develop"],
  repositories: ["*"],
  authors: ["*"],
  minDiffSize: 0,
  maxDiffSize: 2000,
};

// Human-approval requirement for bot-authored PRs
// (`ai_review.bot_pr_human_approvers`): at least `min` humans must approve,
// except for bot authors listed in `exclude` (exact logins, case-insensitive;
// an explicit empty list means "no exemptions").
const BOT_PR_HUMAN_APPROVERS_DEFAULTS = {
  min: 2,
  exclude: ["dependabot[bot]"],
};

// Cache resolved configs per repo for X minutes
const CACHE_TTL_MS = 8 * 60_000;
const configCache = new Map();

// Normalize a raw `providers` value into a clean Set of known providers, or
// null if the value is unusable (so the caller can fall back to the default).
export function normalizeProviders(raw) {
  if (!Array.isArray(raw)) return null;

  const providers = new Set();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const provider = entry.trim().toLowerCase();
    if (!provider) continue;
    if (!KNOWN_PROVIDER_SET.has(provider)) {
      console.warn(`[ai-reviews config] Ignoring unknown provider "${entry}"`);
      continue;
    }
    providers.add(provider);
  }

  return providers.size > 0 ? providers : null;
}

// Normalize a raw `skip_authors` value into a Set of lower-cased logins, or
// null if the value isn't a list (so the caller falls back to the default).
// Unlike providers, an explicit empty list is respected: it means "skip no one".
export function normalizeSkipAuthors(raw) {
  if (!Array.isArray(raw)) return null;

  const authors = new Set();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const login = entry.trim().toLowerCase();
    if (!login) continue;
    authors.add(login);
  }

  return authors;
}

// Normalize a raw `bot_pr_human_approvers` value into { min, exclude }.
// `min` must be a non-negative finite number; `exclude` follows the same
// rules as skip_authors (explicit [] means "no exemptions"). Anything
// unusable falls back to its default.
export function normalizeBotPrHumanApprovers(raw) {
  const min =
    typeof raw?.min === "number" && Number.isFinite(raw.min) && raw.min >= 0
      ? raw.min
      : BOT_PR_HUMAN_APPROVERS_DEFAULTS.min;

  const exclude =
    normalizeSkipAuthors(raw?.exclude) ??
    new Set(BOT_PR_HUMAN_APPROVERS_DEFAULTS.exclude.map((login) => login.toLowerCase()));

  return { min, exclude };
}

// Normalize a raw `ai_review` value into the settings the automatic trigger
// consumes. Unusable entries fall back to the defaults above.
export function normalizeAiReview(raw) {
  // A missing/empty/invalid pattern list falls back to its default — an empty
  // list can't be expressed (leave `automatic` off instead).
  const toPatterns = (value, fallback) => {
    const items = Array.isArray(value)
      ? value
          .filter((entry) => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    return compileFilterPatterns(items.length > 0 ? items : fallback);
  };

  const toSize = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : fallback;

  return {
    automatic: raw?.automatic === true,
    includeDrafts: raw?.include_drafts === true,
    branches: toPatterns(raw?.branches, AI_REVIEW_DEFAULTS.branches),
    repositories: toPatterns(raw?.repositories, AI_REVIEW_DEFAULTS.repositories),
    authors: toPatterns(raw?.authors, AI_REVIEW_DEFAULTS.authors),
    skipAuthors:
      normalizeSkipAuthors(raw?.skip_authors) ?? new Set(DEFAULT_SKIP_AUTHORS.map((login) => login.toLowerCase())),
    minDiffSize: toSize(raw?.min_diff_size, AI_REVIEW_DEFAULTS.minDiffSize),
    maxDiffSize: toSize(raw?.max_diff_size, AI_REVIEW_DEFAULTS.maxDiffSize),
    botPrHumanApprovers: normalizeBotPrHumanApprovers(raw?.bot_pr_human_approvers),
  };
}

// Which pull-request events an agent proxy may be forwarded (see
// agent-proxies.js). Anything else in the config's `events` list is ignored.
const AGENT_EVENTS = new Set(["review", "comment", "check", "mention"]);

// Debounce applied before dispatching to an agent, clamped to a sane range.
const DEFAULT_DEBOUNCE_SECONDS = 45;
const MAX_DEBOUNCE_SECONDS = 300;

function compileAgentRegex(source, label) {
  if (typeof source !== "string" || !source.trim()) return null;
  try {
    return new RegExp(source, "i");
  } catch {
    console.warn(`[agent-proxies config] Ignoring invalid regex for ${label}: "${source}"`);
    return null;
  }
}

function normalizeAgent(raw) {
  if (!raw || typeof raw !== "object") return null;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const bot = typeof raw.bot === "string" ? raw.bot.trim() : "";
  const d = raw.dispatch;
  const dispatch = d && typeof d === "object"
    ? {
        owner: typeof d.owner === "string" ? d.owner.trim() : "",
        repo: typeof d.repo === "string" ? d.repo.trim() : "",
        workflow: (typeof d.workflow === "string" && d.workflow.trim()) || "webhook_event.yml",
        ref: (typeof d.ref === "string" && d.ref.trim()) || "main",
      }
    : null;

  if (!name || !bot || !dispatch || !dispatch.owner || !dispatch.repo) {
    console.warn(`[agent-proxies config] Ignoring agent "${name || "(unnamed)"}": needs name, bot, and dispatch.{owner,repo}`);
    return null;
  }

  const events = new Set(
    (Array.isArray(raw.events) ? raw.events : [...AGENT_EVENTS])
      .filter((e) => AGENT_EVENTS.has(e)),
  );
  const mention = compileAgentRegex(raw.mention, `${name}.mention`);
  const checks = compileAgentRegex(raw.checks, `${name}.checks`);

  // Drop capabilities that can't work without their matcher, so a typo'd
  // regex silently disables just that path rather than misfiring.
  if (!mention) events.delete("mention");
  if (!checks) events.delete("check");
  if (events.size === 0) {
    console.warn(`[agent-proxies config] Ignoring agent "${name}": no usable events`);
    return null;
  }

  const ignoreUsers = new Set(
    (Array.isArray(raw.ignore_users) ? raw.ignore_users : [])
      .filter((u) => typeof u === "string")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  );

  const seconds =
    typeof raw.debounce_seconds === "number" && Number.isFinite(raw.debounce_seconds) && raw.debounce_seconds >= 0
      ? Math.min(raw.debounce_seconds, MAX_DEBOUNCE_SECONDS)
      : DEFAULT_DEBOUNCE_SECONDS;

  return {
    name,
    bot,
    botLower: bot.toLowerCase(),
    events,
    mention,
    checks,
    ignoreUsers,
    debounceMs: seconds * 1000,
    dispatch,
  };
}

// Normalize a raw `agents` value into a list of validated agent proxies.
// Anything malformed is dropped with a warning; a missing/invalid `agents`
// key yields [] so the whole feature stays dormant.
export function normalizeAgents(raw) {
  if (!Array.isArray(raw)) return [];
  const agents = [];
  for (const entry of raw) {
    const agent = normalizeAgent(entry);
    if (agent) agents.push(agent);
  }
  return agents;
}

export async function loadAiReviewConfig(context) {
  const { owner, repo } = context.repo();
  const cacheKey = `${owner}/${repo}`;

  const cached = configCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.config;
  }

  let raw;
  try {
    // Don't pass DEFAULT_CONFIG here: Probot merges defaults via deepmerge,
    // which concatenates arrays — so the default provider list would merge back
    // into a user's config and re-enable providers they disabled. We apply the
    // default ourselves below (normalizeProviders fallback) only when no config
    // file is found anywhere.
    raw = await context.config(CONFIG_FILE);
  } catch (err) {
    console.error(`[config] Failed to load ${CONFIG_FILE}`, err);
    raw = DEFAULT_CONFIG;
  }

  const providers =
    normalizeProviders(raw?.providers) ?? new Set(DEFAULT_CONFIG.providers);
  const aiReview = normalizeAiReview(raw?.ai_review);
  const agents = normalizeAgents(raw?.agents);

  const config = {
    providers,
    aiReview,
    agents,
    isProviderEnabled(provider) {
      return providers.has(provider);
    },
    isAuthorSkipped(login) {
      return typeof login === "string" && aiReview.skipAuthors.has(login.toLowerCase());
    },
  };

  configCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, config });

  return config;
}
