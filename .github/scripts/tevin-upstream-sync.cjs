// Fork-only upstream sync for Tevin2119/t3code. Used by
// .github/workflows/tevin-upstream-sync.yml in three steps:
//   prepare  merge pingdotgg/t3code main into freshly fetched master locally
//   push     publish the sync branch with UPSTREAM_SYNC_TOKEN (never forced)
//   pr       open the replacement PR and supersede older sync PRs
// The workflow runs a copy of this file taken from master, never the candidate's.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const LEGACY_BRANCH = "automation/tevin-upstream-sync";
const DAILY_PREFIX = "automation/upstream-sync-";
const DAILY_BRANCH_PATTERN = /^automation\/upstream-sync-(\d{4}-\d{2}-\d{2})(?:-([1-9]\d*))?$/;
const BASE_BRANCH = "master";
const UPSTREAM_REPO = "pingdotgg/t3code";
const UPSTREAM_URL = `https://github.com/${UPSTREAM_REPO}.git`;
const PR_TITLE = `chore: sync upstream ${UPSTREAM_REPO}`;
const REPORT_PATH = ".github/tevin-upstream-sync-conflicts.md";
const REPORT_MARKER = "<!-- tevin-upstream-sync-conflicts -->";
const BODY_START = "<!-- tevin-upstream-sync:start -->";
const BODY_END = "<!-- tevin-upstream-sync:end -->";
const TOKEN_NAME = "UPSTREAM_SYNC_TOKEN";
// Upstream must never own these, or the sync would conflict with itself.
const RESERVED_PATHS = [
  ".github/workflows/tevin-upstream-sync.yml",
  ".github/scripts/tevin-upstream-sync.cjs",
  ".github/scripts/tevin-upstream-sync.test.cjs",
  REPORT_PATH,
];
// Private ref namespace so fetches never collide with remotes of the checkout.
const REFS = {
  base: "refs/tevin-sync/master",
  upstream: "refs/tevin-sync/upstream",
};
const BOT_IDENTITY = {
  GIT_AUTHOR_NAME: "github-actions[bot]",
  GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "github-actions[bot]",
  GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
};

function git(cwd, args, { env, allowFailure = false } = {}) {
  const result = childProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, ...BOT_IDENTITY },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result;
}

function gitOut(cwd, args, options) {
  return git(cwd, args, options).stdout.trim();
}

function isAncestor(cwd, ancestor, descendant, env) {
  return (
    git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], { env, allowFailure: true })
      .status === 0
  );
}

/**
 * The last upstream commit already in master: the newest commit on upstream's
 * first-parent chain that master contains. Returns null without shared history.
 */
function findRangeStart(cwd, upstreamRef, baseRef, env) {
  const missing = new Set(
    gitOut(cwd, ["rev-list", upstreamRef, `^${baseRef}`], { env })
      .split("\n")
      .filter(Boolean),
  );
  const chain = gitOut(cwd, ["rev-list", "--first-parent", upstreamRef], { env }).split("\n");
  return chain.find((sha) => sha && !missing.has(sha)) ?? null;
}

/** Leaves a clean merge staged; aborts genuine conflicts and returns their paths. */
function mergeRef(cwd, ref, message, env) {
  const ours = gitOut(cwd, ["rev-parse", "HEAD^{commit}"], { env });
  const theirs = gitOut(cwd, ["rev-parse", `${ref}^{commit}`], { env });
  const result = git(cwd, ["merge", "--no-ff", "--no-commit", "-m", message, ref], {
    env,
    allowFailure: true,
  });
  if (result.status === 0) return [];
  const hasUnmerged = gitOut(cwd, ["ls-files", "-u"], { env }) !== "";
  if (!hasUnmerged) {
    throw new Error(`git merge ${ref} failed without conflicts: ${result.stderr.trim()}`);
  }
  git(cwd, ["merge", "--abort"], { env });
  // Full operand IDs keep synthetic directory/file paths consistent with merge-tree.
  const tree = git(cwd, ["merge-tree", "--write-tree", "--name-only", "-z", ours, theirs], {
    env,
    allowFailure: true,
  });
  if (tree.status !== 1) {
    throw new Error(
      `git merge-tree ${ours} ${theirs} expected conflicts, exited ${tree.status}: ${tree.stderr.trim()}`,
    );
  }
  const entries = tree.stdout.split("\0");
  const separator = entries.indexOf("", 1);
  if (!entries[0] || separator <= 1) {
    throw new Error(`git merge-tree ${ours} ${theirs} returned no conflicting path section`);
  }
  return [...new Set(entries.slice(1, separator))].sort();
}

/** Renders a path as an inline code span that survives backticks and control characters. */
function codeSpan(value) {
  const visible = value.replace(/[\u0000-\u001f\u007f]/g, (char) =>
    char === "\n" ? "\\n" : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
  const longestRun = Math.max(0, ...(visible.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad =
    visible.startsWith("`") || visible.endsWith("`") || visible.startsWith(" ") ? " " : "";
  return `${fence}${pad}${visible}${pad}${fence}`;
}

function stageLabel(state) {
  return `merging \`${UPSTREAM_REPO}\` main into \`${state.branch}\``;
}

function compareUrl(start, target) {
  return `https://github.com/${UPSTREAM_REPO}/compare/${start}...${target}`;
}

function renderReport(state) {
  const lines = [
    REPORT_MARKER,
    "",
    "# Upstream sync conflicts",
    "",
    "Written by the upstream sync workflow. Resolve the conflicts on this branch, delete this file, and push.",
    "",
    `- Failed while ${stageLabel(state)}.`,
    `- Upstream range: \`${state.rangeStart}\`..\`${state.target}\``,
  ];
  lines.push("", `## Conflicting files (${state.conflicts.length})`, "");
  for (const file of state.conflicts) lines.push(`- ${codeSpan(file)}`);
  return `${lines.join("\n")}\n`;
}

function readHeadFile(cwd, file, env) {
  const result = git(cwd, ["show", `HEAD:${file}`], { env, allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

function assertOwnedReport(content) {
  if (content !== null && !content.startsWith(REPORT_MARKER)) {
    throw new Error(
      `${REPORT_PATH} exists without the automation marker; refusing to overwrite or delete it`,
    );
  }
}

function commitIfStaged(cwd, message, env) {
  if (git(cwd, ["diff", "--cached", "--quiet"], { env, allowFailure: true }).status === 0) {
    return false;
  }
  git(cwd, ["commit", "--no-verify", "-m", message], { env });
  return true;
}

/** Advance past all same-day suffixes so supersession order survives fresh checkouts. */
function selectBranch(cwd, forkUrl, date, env) {
  const day = new Date(date).toISOString().slice(0, 10);
  const stem = `${DAILY_PREFIX}${day}`;
  const local = gitOut(cwd, ["for-each-ref", "--format=%(refname)", `refs/heads/${stem}*`], {
    env,
  });
  const remote = gitOut(cwd, ["ls-remote", "--heads", forkUrl, `refs/heads/${stem}*`], { env });
  let suffix = 0;
  for (const line of `${local}\n${remote}`.split("\n")) {
    const branch = line
      .split("\t")
      .at(-1)
      .replace(/^refs\/heads\//, "");
    const match = DAILY_BRANCH_PATTERN.exec(branch);
    if (match?.[1] === day) suffix = Math.max(suffix, Number(match[2] ?? 0) + 1);
  }
  return suffix ? `${stem}-${suffix}` : stem;
}

/** Prepare detached from captured master; old sync branches never enter the candidate. */
function prepare({ cwd, forkUrl, upstreamUrl = UPSTREAM_URL, env, date = new Date() }) {
  git(cwd, ["fetch", "--no-tags", forkUrl, `+refs/heads/${BASE_BRANCH}:${REFS.base}`], { env });
  git(cwd, ["fetch", "--no-tags", upstreamUrl, `+refs/heads/main:${REFS.upstream}`], { env });
  const reserved = gitOut(
    cwd,
    ["ls-tree", "-r", "--name-only", REFS.upstream, "--", ...RESERVED_PATHS],
    {
      env,
    },
  );
  if (reserved) {
    throw new Error(
      `Upstream main now has fork-reserved sync paths: ${reserved.split("\n").join(", ")}`,
    );
  }

  const target = gitOut(cwd, ["rev-parse", REFS.upstream], { env });
  const base = gitOut(cwd, ["rev-parse", REFS.base], { env });
  if (isAncestor(cwd, target, base, env)) {
    return { status: "noop", target, base, head: base, changed: false };
  }
  const rangeStart = findRangeStart(cwd, REFS.upstream, REFS.base, env);
  if (!rangeStart) {
    throw new Error(
      `${BASE_BRANCH} shares no history with ${UPSTREAM_REPO} main; refusing to sync`,
    );
  }
  const commitCount = Number(gitOut(cwd, ["rev-list", "--count", target, `^${base}`], { env }));

  const branch = selectBranch(cwd, forkUrl, date, env);
  git(cwd, ["checkout", "--quiet", "--detach", base], { env });
  const existingReport = readHeadFile(cwd, REPORT_PATH, env);
  assertOwnedReport(existingReport);
  const message = `${PR_TITLE} to ${target.slice(0, 12)}`;
  const conflicts = mergeRef(cwd, target, message, env);
  const state = { target, base, branch, rangeStart, commitCount, conflicts, stage: "upstream" };
  if (conflicts.length > 0) {
    state.status = "conflict";
    fs.mkdirSync(path.join(cwd, path.dirname(REPORT_PATH)), { recursive: true });
    fs.writeFileSync(path.join(cwd, REPORT_PATH), renderReport(state));
    git(cwd, ["add", "--", REPORT_PATH], { env });
    commitIfStaged(cwd, "chore: report upstream sync conflicts", env);
  } else {
    state.status = "clean";
    // Remove a previously landed owned report within the merge itself, without a cleanup commit.
    if (existingReport !== null) git(cwd, ["rm", "--quiet", "--", REPORT_PATH], { env });
    git(cwd, ["commit", "--no-verify", "-m", message], { env });
  }
  state.head = gitOut(cwd, ["rev-parse", "HEAD"], { env });
  state.changed = true;
  return state;
}

function requireToken(token) {
  if (!token) {
    throw new Error(
      `${TOKEN_NAME} is not set. Add a fine-grained token for Tevin2119/t3code with Contents, Pull requests and Workflows read and write as the repository secret ${TOKEN_NAME}.`,
    );
  }
}

/**
 * Pushes HEAD to the sync branch only, as a plain fast-forward push. A remote
 * that moved on since prepare rejects the push instead of being overwritten.
 */
function publishBranch({ cwd, state, pushUrl, token, env, log = console.log }) {
  requireToken(token);
  if (state.status === "noop") {
    log(`${UPSTREAM_REPO} main is already in ${BASE_BRANCH}; nothing to push.`);
    return { pushed: false };
  }
  if (!state.changed) {
    log(`${state.branch} is already at ${state.head}; nothing to push.`);
    return { pushed: false };
  }
  // The header lives only in this process's environment, never in a remote, file or argv.
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const authEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: header,
  };
  const result = git(cwd, ["push", "--no-verify", pushUrl, `HEAD:refs/heads/${state.branch}`], {
    env: authEnv,
    allowFailure: true,
  });
  if (result.status !== 0) {
    const stderr = result.stderr.split(token).join("***").trim();
    if (/rejected|non-fast-forward|fetch first/.test(stderr)) {
      throw new Error(
        `${state.branch} changed on the remote during this run; it was not overwritten. Run the sync again.\n${stderr}`,
      );
    }
    throw new Error(
      `Pushing ${state.branch} failed. Check that ${TOKEN_NAME} is valid and has Contents and Workflows write access.\n${stderr}`,
    );
  }
  log(`Pushed ${state.head} to ${state.branch}.`);
  return { pushed: true };
}

function renderSection(state) {
  const lines = [BODY_START];
  if (state.status === "clean") {
    lines.push(
      `Merges ${state.commitCount} upstream commit(s) from \`${UPSTREAM_REPO}\` main into \`${BASE_BRANCH}\`.`,
      "",
      `- Last upstream commit already in \`${BASE_BRANCH}\`: \`${state.rangeStart}\``,
      `- Upstream main commit merged: \`${state.target}\``,
      `- Range: [\`${state.rangeStart.slice(0, 12)}...${state.target.slice(0, 12)}\`](${compareUrl(state.rangeStart, state.target)})`,
    );
  } else {
    lines.push(
      `Upstream sync is pending: ${state.conflicts.length} file(s) conflicted while ${stageLabel(state)}.`,
      "",
      `- Last upstream commit already in \`${BASE_BRANCH}\`: \`${state.rangeStart}\``,
      `- Upstream main commit to merge: \`${state.target}\` (${state.commitCount} commit(s))`,
      `- Range: [\`${state.rangeStart.slice(0, 12)}...${state.target.slice(0, 12)}\`](${compareUrl(state.rangeStart, state.target)})`,
    );
    lines.push("", "Conflicting files:", "");
    for (const file of state.conflicts) lines.push(`- ${codeSpan(file)}`);
    lines.push(
      "",
      `To resolve: check out \`${state.branch}\`, run \`git merge ${state.target}\`, resolve the files, delete \`${REPORT_PATH}\`, commit and push to the same branch.`,
    );
  }
  lines.push(BODY_END);
  return lines.join("\n");
}

/** Replaces only the automation-owned section, keeping text people added around it. */
function mergeBody(existing, section) {
  const body = existing ?? "";
  const start = body.indexOf(BODY_START);
  const end = body.indexOf(BODY_END);
  if (start !== -1 && end > start) {
    return body.slice(0, start) + section + body.slice(end + BODY_END.length);
  }
  return body.trim() ? `${section}\n\n${body}` : section;
}

function isOlderSyncBranch(branch, replacement) {
  if (branch === LEGACY_BRANCH) return true;
  const old = DAILY_BRANCH_PATTERN.exec(branch ?? "");
  const next = DAILY_BRANCH_PATTERN.exec(replacement);
  if (!old || !next) return false;
  return old[1] < next[1] || (old[1] === next[1] && Number(old[2] ?? 0) < Number(next[2] ?? 0));
}

async function supersedePullRequests(api, repo, state, replacement) {
  const listed = [];
  // Closing a PR shrinks the open-only pages. Snapshot every page before any mutation.
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      state: "open",
      base: BASE_BRANCH,
      per_page: "100",
      page: String(page),
    });
    const batch = await api.request("GET", `/repos/${repo}/pulls?${query}`);
    listed.push(...batch);
    if (batch.length < 100) break;
  }
  for (const pr of listed) {
    if (
      pr.number === replacement.number ||
      pr.head?.repo?.full_name !== repo ||
      pr.base?.ref !== BASE_BRANCH ||
      !isOlderSyncBranch(pr.head?.ref, state.branch)
    )
      continue;
    await api.request("POST", `/repos/${repo}/issues/${pr.number}/comments`, {
      body: `Superseded by ${replacement.html_url}. The branch is retained for recovery of unmerged resolutions.`,
    });
    await api.request("PATCH", `/repos/${repo}/pulls/${pr.number}`, { state: "closed" });
  }
}

/** Retry by the prepared branch; preserve reviewer text and supersede only after success. */
async function upsertPullRequest({ api, repo, state, log = console.log }) {
  if (state.status === "noop") return null;
  const owner = repo.split("/")[0];
  const query = new URLSearchParams({
    state: "open",
    base: BASE_BRANCH,
    head: `${owner}:${state.branch}`,
  });
  const listed = await api.request("GET", `/repos/${repo}/pulls?${query}`);
  const matches = listed.filter(
    (pr) =>
      pr.head?.ref === state.branch &&
      pr.head?.repo?.full_name === repo &&
      pr.base?.ref === BASE_BRANCH,
  );
  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} open sync PRs (${matches.map((pr) => `#${pr.number}`).join(", ")}); close all but one`,
    );
  }
  const wantDraft = state.status === "conflict";
  const section = renderSection(state);
  let pr = matches[0];
  if (!pr) {
    pr = await api.request("POST", `/repos/${repo}/pulls`, {
      title: PR_TITLE,
      head: state.branch,
      base: BASE_BRANCH,
      body: section,
      draft: wantDraft,
    });
    log(`Opened sync PR #${pr.number}${wantDraft ? " as draft" : ""}: ${pr.html_url}`);
  } else {
    const body = mergeBody(pr.body, section);
    pr = {
      ...pr,
      ...(await api.request("PATCH", `/repos/${repo}/pulls/${pr.number}`, {
        title: PR_TITLE,
        body,
      })),
    };
    log(`Updated sync PR #${pr.number}: ${pr.html_url}`);
  }
  // REST cannot change draft state on an existing PR; GraphQL can.
  if (Boolean(pr.draft) !== wantDraft) {
    const mutation = wantDraft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    await api.graphql(
      `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
      { id: pr.node_id },
    );
    pr = { ...pr, draft: wantDraft };
    log(`Sync PR #${pr.number} is now ${wantDraft ? "a draft" : "ready for review"}.`);
  }
  await supersedePullRequests(api, repo, state, pr);
  return pr;
}

function createApi(token, fetchImpl = fetch) {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "tevin-upstream-sync",
    "x-github-api-version": "2022-11-28",
  };
  async function call(method, apiPath, body) {
    const response = await fetchImpl(`https://api.github.com${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub ${method} ${apiPath.split("?")[0]} failed: ${response.status} ${text.slice(0, 500)}`,
      );
    }
    return text ? JSON.parse(text) : null;
  }
  return {
    request: call,
    async graphql(query, variables) {
      const result = await call("POST", "/graphql", { query, variables });
      if (result.errors?.length) {
        throw new Error(
          `GitHub GraphQL failed: ${result.errors.map((error) => error.message).join("; ")}`,
        );
      }
      return result.data;
    },
  };
}

function summarize(state, pr) {
  if (state.status === "noop")
    return `${UPSTREAM_REPO} main (${state.target}) is already in ${BASE_BRANCH}.`;
  const range = `\`${state.rangeStart}\`..\`${state.target}\``;
  const head =
    state.status === "clean"
      ? `Clean sync of ${range}.`
      : `${state.conflicts.length} conflicting file(s) syncing ${range}.`;
  return `${head} Branch: \`${state.branch}\`.${pr ? ` PR: ${pr.html_url}` : ""}`;
}

function appendFile(file, text) {
  if (file) fs.appendFileSync(file, text);
}

async function main(command) {
  const env = process.env;
  const repo = env.GITHUB_REPOSITORY;
  const forkUrl = `https://github.com/${repo}.git`;
  const statePath = path.join(env.RUNNER_TEMP, "tevin-upstream-sync-state.json");
  if (command === "prepare") {
    const state = prepare({ cwd: process.cwd(), forkUrl });
    fs.writeFileSync(statePath, JSON.stringify(state));
    appendFile(env.GITHUB_OUTPUT, `status=${state.status}\nchanged=${state.changed}\n`);
    appendFile(env.GITHUB_STEP_SUMMARY, `${summarize(state)}\n`);
    console.log(summarize(state));
    for (const file of state.conflicts ?? []) console.log(`conflict: ${JSON.stringify(file)}`);
    return;
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const token = env[TOKEN_NAME];
  if (command === "push") {
    publishBranch({ cwd: process.cwd(), state, pushUrl: forkUrl, token });
    return;
  }
  if (command === "pr") {
    requireToken(token);
    const pr = await upsertPullRequest({ api: createApi(token), repo, state });
    if (pr) appendFile(env.GITHUB_STEP_SUMMARY, `${summarize(state, pr)}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main(process.argv[2]).catch((error) => {
    console.log(`::error::${error.message.split("\n")[0]}`);
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  BODY_END,
  BODY_START,
  PR_TITLE,
  REPORT_MARKER,
  REPORT_PATH,
  LEGACY_BRANCH,
  codeSpan,
  createApi,
  findRangeStart,
  mergeBody,
  prepare,
  publishBranch,
  renderReport,
  upsertPullRequest,
};
