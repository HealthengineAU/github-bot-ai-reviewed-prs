# Healthengine Review GitHub App

<div align=right>

⚙️ [Config](https://github.com/HealthengineAU/.github/blob/main/.github/healthengine-review.yml)
| 📲 [GitHub App](https://github.com/organizations/HealthengineAU/settings/apps/healthengine-review)

</div>

## Features

- Manages the `AI Review` commit status:
  - Added once a pull request has requested/received AI review
  - Shows a passing `Requested <reviewer>` state as soon as a review is
    summoned (via any trigger below, a requested Copilot reviewer, or a
    human-typed `auggie review` comment), then flips to `Reviewed by …`
  - Tracks whether AI feedback has been addressed (i.e. resolved, responded to, is now outdated)
  - Can be skipped with `skip-ai-review` label, or for specific PR authors via
    `ai_review.skip_authors` (default `dependabot[bot]`)
  - Holds bot-authored PRs at pending until enough humans have approved
    (`ai_review.bot_pr_human_approvers`, default 2; `exclude` exempts specific bots)
- Triggers AI reviews:
  - Commenting `ai review` (or `<provider> review` for a specific bot)
  - Requesting review from teams named `HealthengineAU/AI Review` or `HealthengineAU/<provider>`
  - Labelling a pull request with `ai-review` label
- Automatically invites a random AI reviewer (opt-in via `ai_review.automatic`):
  - When a pull request is opened, marked ready for review, or reopened
  - Only when the PR has no completed AI review and no pending AI review
    request (a requested Copilot, an Auggie summon, an AI-review team request,
    or an incoming LinearB review — detected via a present, non-failing
    `gitStream.cm` commit status)
  - Evaluated ~30s after the PR event so gitStream's status has time to land
  - Skips authors listed in `ai_review.skip_authors` (default `dependabot[bot]`),
    PRs labelled `skip-ai-review`, and drafts (unless `ai_review.include_drafts: true`)
  - Configurable via `ai_review` (see below): target branches, repos, and
    authors as GitHub-Actions-style filter patterns, plus min/max diff size
    (defaults 0–2000 changed lines)
- Cleans up AI reviewer comments:
  - Removing links to unsupported features
  - Collapses summaries
- Forwards activity to autonomous agent proxies (opt-in via `agents`):
  - Wakes an agent when its own PRs receive a review, a comment, or a completed/failed/errored status check, and when it's `@`-mentioned on any PR
  - Coalesces bursts (debounced) and pokes the agent via a `workflow_dispatch`
    to a target it configures — the app itself knows nothing about any agent

## Tests

Unit and handler tests run on the built-in Node test runner (no extra dependencies):

```sh
npm test
```

They also run automatically on every pull request and on pushes to `main` via
the [Test workflow](.github/workflows/test.yml). Tests live in [test/](test/):
pure helpers are tested directly, and event handlers are exercised against a
lightweight `octokit`/`context` mock in [test/helpers/mock-github.js](test/helpers/mock-github.js).

## Config file

Use the [.github/healthengine-review.yml](https://github.com/HealthengineAU/.github/blob/main/.github/healthengine-review.yml) file in the organization's special `.github` repo to configure settings for all repos:

```yml
# supported: augment, claude, copilot, greptile, linearb
providers:
  - augment
  - claude
  - copilot
  - greptile
  - linearb

# AI review settings (all keys optional; defaults shown)
#
# branches / repositories / authors take GitHub-Actions-style filter patterns:
# `*` (segment wildcard), `**` (spans "/", for branch names), and `!` to
# negate a previous match — evaluated in order, last match wins.
# Quote patterns that start with * or ! (YAML special characters).
ai_review:
  automatic: false       # set true to auto-invite a reviewer on eligible PRs
  include_drafts: false  # set true to also invite on draft PRs
  branches:              # base branches whose PRs are invited
    - master
    - main
    - develop
  repositories: ["*"]    # e.g. ["*", "!legacy-monolith"]
  authors: ["*"]         # e.g. ["*", "!*-service-account"]
  skip_authors:          # PR authors whose PRs skip AI review entirely
    - "dependabot[bot]"  # (exact logins, case-insensitive; [] to skip no one)
  min_diff_size: 0       # inclusive bounds on additions + deletions;
  max_diff_size: 2000    # PRs outside the range aren't auto-invited
  bot_pr_human_approvers:  # human approvals required on bot-authored PRs
    min: 2                 # minimum number of human approvers
    exclude:               # bot authors exempt from the requirement
      - "dependabot[bot]"  # (exact logins, case-insensitive; [] for none)

# Agent proxies (optional; omit the key entirely to disable).
#
# Each entry forwards pull-request activity to an autonomous agent that runs
# elsewhere and opens PRs under its own bot identity. The app stays generic —
# every identity, trigger, and dispatch target lives here in config.
#
# Requires the app to have Actions: Read and write on the dispatch target repo.
# `dispatch.owner` must be within the same org the events come from.
agents:
  - name: my-agent            # label, for logs
    bot: my-agent[bot]        # the agent's own login — matches its PRs, skips its own noise
    events: [review, comment, check, mention]   # which activity to forward (default: all four)
    mention: '@my-agent\b'    # regex; needed for `mention` events
    checks: '^buildkite/'     # regex over commit-status contexts; needed for `check` events
    ignore_users:             # human-looking service accounts to drop on comments
      - "healthengine-sre"
    debounce_seconds: 45      # coalesce a burst on one PR into one dispatch (max 300)
    dispatch:                 # where the agent gets poked (a workflow_dispatch)
      owner: HealthengineAU
      repo: my-agent
      workflow: webhook_event.yml  # optional, defaults to webhook_event.yml
      ref: main                    # optional, defaults to main
```

For each configured agent the app forwards:

- **review** / **comment** — a review or human comment on one of the agent's own
  PRs. Reviews accept humans *and* bots (AI reviewers count); comments are
  humans-only, minus `ignore_users`. Approvals are ignored.
- **mention** — a human `@`-mentioning the agent on any PR in the org.
- **check** — a settled (non-pending) commit status matching `checks` on one of
  the agent's PRs. The body carries the outcome, e.g. `failure: buildkite/test`.

Each dispatch sends `{ event, repo, pr, actor, body }` as workflow inputs. What
the agent does with them — and any authorization of `actor` — is the agent's own
concern.
