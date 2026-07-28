// Lightweight test doubles for a Probot `app`, `context`, and `octokit`.
// No network, no real Probot — just enough surface for the handlers we register.

// Captures every `app.on(events, handler)` registration so tests can dispatch
// a synthetic webhook to the matching handler(s).
export function makeApp() {
  const handlers = new Map(); // event name -> array of handlers

  const app = {
    on(events, handler) {
      for (const event of Array.isArray(events) ? events : [events]) {
        const list = handlers.get(event) || [];
        list.push(handler);
        handlers.set(event, list);
      }
    },
  };

  async function dispatch(event, context) {
    const list = handlers.get(event) || [];
    for (const handler of list) {
      await handler(context);
    }
    return list.length; // how many handlers ran (useful for assertions)
  }

  return { app, dispatch, handlers };
}

// Records every octokit call as { method, args } so tests can assert on them.
// `responses` maps a dotted method path (e.g. "rest.issues.createComment") to
// either a value or a (args) => value function used as the resolved result.
export function makeOctokit(responses = {}) {
  const calls = [];

  const record = (method) => async (args) => {
    calls.push({ method, args });
    const responder = responses[method];
    const value = typeof responder === "function" ? responder(args) : responder;
    return value ?? { data: {} };
  };

  const octokit = {
    calls,
    // paginate(fn, params) — our mocks tag fn with `_method`; return the
    // configured array (defaults to []).
    paginate: async (fn, params) => {
      const method = fn?._method ?? "paginate";
      calls.push({ method: `paginate:${method}`, args: params });
      const responder = responses[`paginate:${method}`];
      const value = typeof responder === "function" ? responder(params) : responder;
      return value ?? [];
    },
    graphql: async (query, vars) => {
      calls.push({ method: "graphql", args: { query, vars } });
      const responder = responses["graphql"];
      return (typeof responder === "function" ? responder(vars) : responder) ?? {};
    },
    rest: {
      actions: {
        createWorkflowDispatch: record("rest.actions.createWorkflowDispatch"),
      },
      repos: {
        createCommitStatus: record("rest.repos.createCommitStatus"),
        getCombinedStatusForRef: record("rest.repos.getCombinedStatusForRef"),
        listPullRequestsAssociatedWithCommit: record("rest.repos.listPullRequestsAssociatedWithCommit"),
      },
      issues: {
        listComments: tag("rest.issues.listComments"),
        createComment: record("rest.issues.createComment"),
        updateComment: record("rest.issues.updateComment"),
        removeLabel: record("rest.issues.removeLabel"),
      },
      pulls: {
        get: record("rest.pulls.get"),
        listReviews: tag("rest.pulls.listReviews"),
        listReviewComments: tag("rest.pulls.listReviewComments"),
        requestReviewers: record("rest.pulls.requestReviewers"),
        updateReview: record("rest.pulls.updateReview"),
        updateReviewComment: record("rest.pulls.updateReviewComment"),
      },
      reactions: {
        createForIssueComment: record("rest.reactions.createForIssueComment"),
        listForIssueComment: tag("rest.reactions.listForIssueComment"),
      },
    },
    // Some handlers call context.octokit.pulls.* (not rest.pulls.*).
    pulls: {
      removeRequestedReviewers: record("pulls.removeRequestedReviewers"),
    },
  };

  return octokit;

  // A function usable both directly and as a paginate() target: it carries a
  // `_method` tag so paginate() can look up the right canned response.
  function tag(method) {
    const fn = record(method);
    fn._method = method;
    return fn;
  }
}

// Builds a fake Probot context around a payload. `repo` defaults to a unique
// value per call so modules that cache config per repo don't leak across tests.
let ctxRepoCounter = 0;
export function makeContext({
  payload,
  octokit,
  owner = "acme",
  repo = `repo-${ctxRepoCounter++}`,
  config,
} = {}) {
  return {
    payload,
    octokit,
    repo: () => ({ owner, repo }),
    pullRequest: () => ({
      owner,
      repo,
      pull_number: payload?.pull_request?.number ?? payload?.issue?.number,
    }),
    config: async () => config,
  };
}
