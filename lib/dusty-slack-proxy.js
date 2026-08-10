// Forwards Slack @-mentions of Dusty to Dusty's webhook_event.yml, the Slack
// sibling of agent-proxies.js. Slack's app_mention fires wherever a user tags
// @Dusty — including partway down a thread — and this pokes Dusty via a
// workflow_dispatch so a session can start or wake.
//
// The trust boundary for "any workspace user may trigger Dusty" is the Slack
// request signature plus the team_id check below — nothing else authenticates a
// Slack caller, so verification is mandatory. Message text is untrusted DATA
// carried through to the session, never instructions.

import crypto from "node:crypto";

// Where Dusty gets poked — same target as the GitHub proxy.
const DISPATCH = {
  owner: "HealthengineAU",
  repo: "dusty",
  workflow: "webhook_event.yml",
  ref: "main",
};

// Reject deliveries whose timestamp is older than this — replay protection.
const MAX_SKEW_MS = 5 * 60 * 1000;

// Slack redelivers on any slow/non-2xx ack; remember recent event_ids so a retry
// doesn't wake Dusty twice. Bounded, best-effort, module-level.
const SEEN_TTL_MS = 10 * 60 * 1000;
const seen = new Map();
function alreadySeen(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now + SEEN_TTL_MS);
  return false;
}

// Cap the forwarded text — dispatch inputs are bounded and we only need the
// tagging message, not an essay.
const MAX_BODY = 8000;

// --- Pure verification/classification (no IO) — tested directly. ------------

// Constant-time HMAC-v0 check over Slack's signing basestring.
export function verifySlackSignature({ signingSecret, timestamp, rawBody, signature, now = Date.now() }) {
  if (!signingSecret || !timestamp || !signature) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > MAX_SKEW_MS) return false;
  const basestring = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + crypto.createHmac("sha256", signingSecret).update(basestring).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Decide whether an app_mention should wake Dusty, and extract the facts
// webhook_event.yml needs. Returns null to ignore (our own/other bots' messages,
// wrong workspace, malformed). thread_ts||ts as the key means a mid-thread tag
// adopts the whole thread.
export function classifyMention(event, { teamId, allowedTeam } = {}) {
  if (!event || event.type !== "app_mention") return null;
  if (event.bot_id || event.app_id) return null;
  if (allowedTeam && teamId && teamId !== allowedTeam) return null;
  const channel = event.channel;
  const thread = event.thread_ts || event.ts;
  const user = event.user;
  if (!channel || !thread || !user) return null;
  const text = String(event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  return {
    event: "slack",
    slack_channel: channel,
    slack_thread: thread,
    slack_ts: event.ts,
    slack_team: teamId || event.team || "",
    actor: user,
    body: text.slice(0, MAX_BODY),
  };
}

// --- Wiring -----------------------------------------------------------------

// Probot passes getRouter in the application function's SECOND argument — it is
// not a method on `app`. It's absent outside the HTTP server (e.g. `probot
// receive`), where there is nothing to mount onto, so this no-ops there.
export function register(app, { getRouter } = {}) {
  if (typeof getRouter !== "function") {
    app?.log?.warn?.("[dusty-slack] no router available — /slack/events not mounted");
    return;
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const allowedTeam = process.env.SLACK_TEAM_ID;

  // Slack requests carry no GitHub context, so mint (and cache) an
  // installation-authed Octokit for our org ourselves.
  let octokitPromise;
  async function orgOctokit() {
    if (!octokitPromise) {
      octokitPromise = (async () => {
        const appOctokit = await app.auth();
        const { data: install } = await appOctokit.rest.apps.getOrgInstallation({ org: DISPATCH.owner });
        return app.auth(install.id);
      })().catch((err) => {
        octokitPromise = undefined; // let the next request retry
        throw err;
      });
    }
    return octokitPromise;
  }

  // Mounted at the root router, so the full path below is the URL Slack posts to
  // (and the one hardcoded in the Slack app manifest).
  const router = getRouter();

  // Raw body is required for signature verification — parse bytes, not JSON.
  router.post(
    "/slack/events",
    (req, res, next) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        req.rawBody = Buffer.concat(chunks).toString("utf8");
        next();
      });
      req.on("error", next);
    },
    async (req, res) => {
      const rawBody = req.rawBody ?? "";
      let payload;
      try {
        payload = JSON.parse(rawBody || "{}");
      } catch {
        return res.status(400).send("bad json");
      }

      // URL verification handshake.
      if (payload.type === "url_verification") {
        return res.status(200).json({ challenge: payload.challenge });
      }

      // Signature gate — the trust boundary.
      if (!verifySlackSignature({
        signingSecret,
        timestamp: req.headers["x-slack-request-timestamp"],
        rawBody,
        signature: req.headers["x-slack-signature"],
      })) {
        return res.status(401).send("bad signature");
      }

      // Ack immediately (Slack's 3s budget); do the work after.
      res.status(200).send();

      if (payload.type !== "event_callback") return;
      if (alreadySeen(payload.event_id)) return;

      const inputs = classifyMention(payload.event, { teamId: payload.team_id, allowedTeam });
      if (!inputs) return;

      try {
        const octokit = await orgOctokit();
        await octokit.rest.actions.createWorkflowDispatch({
          owner: DISPATCH.owner,
          repo: DISPATCH.repo,
          workflow_id: DISPATCH.workflow,
          ref: DISPATCH.ref,
          inputs,
        });
      } catch (err) {
        console.error("[dusty-slack] dispatch failed:", err.status ?? err.message);
      }
    },
  );
}
