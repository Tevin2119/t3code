const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BODY_START,
  PR_TITLE,
  REPORT_MARKER,
  REPORT_PATH,
  SYNC_BRANCH,
  findRangeStart,
  prepare,
  publishBranch,
  upsertPullRequest,
} = require("./tevin-upstream-sync.cjs");

const REPO = "Tevin2119/t3code";
const TOKEN = "sentinel-token-7f3a9c";
const ODD_PATHS = [
  "docs/with space.md",
  "-leading-dash.txt",
  "ünïcode/fïle.ts",
  "tick`pipe|name.md",
];

// Each fixture gets its own HOME and global config, so results match on any machine.
function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tevin-upstream-sync-"));
  const globalConfig = path.join(root, "gitconfig");
  fs.writeFileSync(
    globalConfig,
    [
      "[user]",
      "\tname = Fixture",
      "\temail = fixture@example.com",
      "[init]",
      "\tdefaultBranch = master",
      "[commit]",
      "\tgpgsign = false",
      "[core]",
      "\tquotePath = false",
      "",
    ].join("\n"),
  );
  const env = {
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0",
  };
  const run = (cwd, args, { allowFailure = false } = {}) => {
    const result = childProcess.spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    if (result.status !== 0 && !allowFailure) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result;
  };
  const out = (cwd, args) => run(cwd, args).stdout.trim();

  const origin = path.join(root, "origin.git");
  const upstream = path.join(root, "upstream.git");
  const up = path.join(root, "up");
  const fork = path.join(root, "fork");
  run(root, ["init", "--bare", "--quiet", origin]);
  run(root, ["init", "--bare", "--quiet", upstream]);
  run(root, ["init", "--quiet", "-b", "main", up]);
  run(up, ["remote", "add", "origin", upstream]);

  const write = (repo, files) => {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(repo, file);
      if (content === null) {
        run(repo, ["rm", "--quiet", "--", file]);
        continue;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      run(repo, ["add", "--", file]);
    }
  };
  const commit = (repo, files, message) => {
    write(repo, files);
    run(repo, ["commit", "--quiet", "--allow-empty", "-m", message]);
    return out(repo, ["rev-parse", "HEAD"]);
  };

  const fixture = {
    root,
    env,
    origin,
    upstream,
    up,
    fork,
    run,
    out,
    write,
    commit,
    runs: 0,
    /** Commits on upstream main and publishes it. */
    upstreamCommit(files, message) {
      const sha = commit(up, files, message);
      run(up, ["push", "--quiet", "origin", "main"]);
      return sha;
    },
    /** Starts the fork's master from upstream's current main. */
    forkFromUpstream() {
      run(root, ["clone", "--quiet", "-b", "main", upstream, fork]);
      run(fork, ["checkout", "--quiet", "-b", "master"]);
      run(fork, ["remote", "set-url", "origin", origin]);
      run(fork, ["remote", "add", "upstream", upstream]);
      run(fork, ["push", "--quiet", "origin", "master"]);
    },
    /** Commits on the fork's master and publishes it. */
    masterCommit(files, message) {
      run(fork, ["checkout", "--quiet", "master"]);
      const sha = commit(fork, files, message);
      run(fork, ["push", "--quiet", "origin", "master"]);
      return sha;
    },
    originRef(ref) {
      const result = run(origin, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], {
        allowFailure: true,
      });
      return result.status === 0 ? result.stdout.trim() : null;
    },
    /** A fresh runner checkout of origin master, as actions/checkout leaves it. */
    checkout() {
      fixture.runs += 1;
      const dir = path.join(root, `runner-${fixture.runs}`);
      run(root, ["clone", "--quiet", "-b", "master", origin, dir]);
      return dir;
    },
    /** A person's clone of the sync branch, used to push resolutions. */
    humanClone() {
      fixture.runs += 1;
      const dir = path.join(root, `human-${fixture.runs}`);
      run(root, ["clone", "--quiet", "-b", SYNC_BRANCH, origin, dir]);
      run(dir, ["remote", "add", "upstream", upstream]);
      run(dir, ["fetch", "--quiet", "upstream"]);
      return dir;
    },
  };
  return fixture;
}

function createGitHub() {
  const prs = [];
  const calls = [];
  let failNextCreate = false;
  const api = {
    async request(method, apiPath, body) {
      calls.push({ method, apiPath, body });
      const [pathname, search] = apiPath.split("?");
      if (method === "GET" && pathname === `/repos/${REPO}/pulls`) {
        const query = new URLSearchParams(search);
        assert.equal(query.get("head"), `Tevin2119:${SYNC_BRANCH}`);
        assert.equal(query.get("base"), "master");
        assert.equal(query.get("state"), "open");
        return prs.filter((pr) => pr.state === "open").map((pr) => ({ ...pr }));
      }
      if (method === "POST" && pathname === `/repos/${REPO}/pulls`) {
        if (failNextCreate) {
          failNextCreate = false;
          throw new Error("GitHub POST /pulls failed: 502");
        }
        const pr = {
          number: prs.length + 1,
          node_id: `PR_${prs.length + 1}`,
          html_url: `https://github.com/${REPO}/pull/${prs.length + 1}`,
          state: "open",
          title: body.title,
          body: body.body,
          draft: Boolean(body.draft),
          head: { ref: body.head, repo: { full_name: REPO } },
          base: { ref: body.base },
        };
        prs.push(pr);
        return { ...pr };
      }
      const update = pathname.match(new RegExp(`^/repos/${REPO}/pulls/(\\d+)$`));
      if (method === "PATCH" && update) {
        // REST cannot change draft state on an existing PR, so a draft field here is a bug.
        assert.ok(!("draft" in body), "draft state must change through GraphQL");
        const pr = prs.find((candidate) => candidate.number === Number(update[1]));
        Object.assign(pr, body);
        return { ...pr };
      }
      throw new Error(`unexpected ${method} ${apiPath}`);
    },
    async graphql(query, variables) {
      calls.push({ method: "GRAPHQL", query, variables });
      const pr = prs.find((candidate) => candidate.node_id === variables.id);
      if (query.includes("convertPullRequestToDraft")) pr.draft = true;
      else if (query.includes("markPullRequestReadyForReview")) pr.draft = false;
      else throw new Error(`unexpected mutation ${query}`);
      return {};
    },
  };
  return {
    api,
    prs,
    calls,
    failCreateOnce() {
      failNextCreate = true;
    },
    open: () => prs.filter((pr) => pr.state === "open"),
  };
}

/** One workflow run: prepare, push and PR, with master checked untouched afterwards. */
async function sync(fixture, github, { token = TOKEN } = {}) {
  const masterBefore = fixture.originRef("master");
  const cwd = fixture.checkout();
  const logs = [];
  const log = (line) => logs.push(line);
  const state = prepare({
    cwd,
    forkUrl: fixture.origin,
    upstreamUrl: fixture.upstream,
    env: fixture.env,
  });
  try {
    const push = publishBranch({
      cwd,
      state,
      pushUrl: fixture.origin,
      token,
      env: fixture.env,
      log,
    });
    const pr = await upsertPullRequest({ api: github.api, repo: REPO, state, log });
    return { cwd, state, push, pr, logs };
  } finally {
    assert.equal(fixture.originRef("master"), masterBefore, "master must never move");
    assert.ok(!fs.readFileSync(path.join(cwd, ".git/config"), "utf8").includes(TOKEN));
    assert.ok(!logs.join("\n").includes(TOKEN));
  }
}

/** Independent conflict oracle: git merge-tree on the same two commits. */
function mergeTreeConflicts(fixture, cwd, ours, theirs) {
  const result = fixture.run(
    cwd,
    ["merge-tree", "--write-tree", "--name-only", "-z", ours, theirs],
    {
      allowFailure: true,
    },
  );
  assert.equal(result.status, 1, "fixture should conflict");
  const [, ...rest] = result.stdout.split("\0");
  const paths = [];
  for (const entry of rest) {
    if (entry === "") break;
    paths.push(entry);
  }
  return [...new Set(paths)].sort();
}

function baseFixture() {
  const fixture = createFixture();
  const base = fixture.upstreamCommit(
    {
      "README.md": "upstream\n",
      ".github/workflows/ci.yml": "name: CI\n",
      ...Object.fromEntries(ODD_PATHS.map((file) => [file, "base\n"])),
    },
    "upstream base",
  );
  fixture.forkFromUpstream();
  fixture.masterCommit({ "apps/web/src/components/delivery/Board.tsx": "board\n" }, "fork: board");
  return { fixture, base };
}

test("does nothing when upstream main is already in master, even on repeat runs", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  for (let i = 0; i < 2; i += 1) {
    const result = await sync(fixture, github);
    assert.equal(result.state.status, "noop");
    assert.equal(result.push.pushed, false);
    assert.equal(result.pr, null);
  }
  assert.equal(fixture.originRef(SYNC_BRANCH), null);
  assert.deepEqual(github.calls, []);
});

test("a missing UPSTREAM_SYNC_TOKEN fails before any push, on the no-op and the gap path", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  await assert.rejects(sync(fixture, github, { token: "" }), /UPSTREAM_SYNC_TOKEN/);
  fixture.upstreamCommit({ "README.md": "upstream 2\n" }, "upstream 2");
  await assert.rejects(sync(fixture, github, { token: null }), /UPSTREAM_SYNC_TOKEN/);
  assert.equal(fixture.originRef(SYNC_BRANCH), null);
  assert.deepEqual(github.calls, []);
});

test("a clean sync that changes workflow files pushes and opens one ready PR with the range", async () => {
  const { fixture, base } = baseFixture();
  const github = createGitHub();
  fixture.upstreamCommit({ "README.md": "upstream 2\n" }, "upstream 2");
  const target = fixture.upstreamCommit(
    { ".github/workflows/ci.yml": "name: CI\non: pull_request\n" },
    "upstream: change ci",
  );

  const first = await sync(fixture, github);
  assert.equal(first.state.status, "clean");
  assert.equal(first.state.rangeStart, base);
  assert.equal(first.state.target, target);
  assert.equal(first.state.commitCount, 2);
  const tip = fixture.originRef(SYNC_BRANCH);
  fixture.run(fixture.root, [
    "--git-dir",
    fixture.origin,
    "merge-base",
    "--is-ancestor",
    target,
    tip,
  ]);
  assert.equal(
    fixture.out(fixture.root, [
      "--git-dir",
      fixture.origin,
      "show",
      `${tip}:.github/workflows/ci.yml`,
    ]),
    "name: CI\non: pull_request",
  );
  assert.equal(github.prs.length, 1);
  const [pr] = github.prs;
  assert.equal(pr.title, PR_TITLE);
  assert.equal(pr.draft, false);
  assert.equal(pr.head.ref, SYNC_BRANCH);
  assert.ok(pr.body.includes(base) && pr.body.includes(target));
  assert.ok(pr.body.includes(`compare/${base}...${target}`));

  // A rerun with nothing new pushes nothing and keeps the same PR and a person's notes.
  pr.body = `Reviewer notes.\n\n${pr.body}`;
  const second = await sync(fixture, github);
  assert.equal(second.state.changed, false);
  assert.equal(second.push.pushed, false);
  assert.equal(fixture.originRef(SYNC_BRANCH), tip);
  assert.equal(github.prs.length, 1);
  assert.ok(pr.body.startsWith("Reviewer notes."));
  assert.equal(pr.body.split(BODY_START).length, 2);
});

test("a conflicting sync opens a draft listing every conflicting path, with no conflict markers", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  fixture.masterCommit(
    Object.fromEntries(ODD_PATHS.map((file) => [file, "fork\n"])),
    "fork: edit odd paths",
  );
  const target = fixture.upstreamCommit(
    Object.fromEntries(ODD_PATHS.map((file) => [file, "upstream\n"])),
    "upstream: edit odd paths",
  );

  const result = await sync(fixture, github);
  const expected = mergeTreeConflicts(fixture, result.cwd, "refs/tevin-sync/master", target);
  assert.equal(expected.length, ODD_PATHS.length);
  assert.equal(result.state.status, "conflict");
  assert.equal(result.state.stage, "upstream");
  assert.deepEqual(result.state.conflicts, expected);
  assert.equal(fixture.out(result.cwd, ["ls-files", "-u"]), "");

  // The pushed candidate differs from master only by the generated report.
  const tip = fixture.originRef(SYNC_BRANCH);
  const master = fixture.originRef("master");
  assert.equal(
    fixture.out(fixture.root, ["--git-dir", fixture.origin, "diff", "--name-only", master, tip]),
    REPORT_PATH,
  );
  const report = fixture.out(fixture.root, [
    "--git-dir",
    fixture.origin,
    "show",
    `${tip}:${REPORT_PATH}`,
  ]);
  assert.ok(report.startsWith(REPORT_MARKER));
  assert.ok(report.includes("``tick`pipe|name.md``"));

  const [pr] = github.prs;
  assert.equal(pr.draft, true);
  for (const file of ODD_PATHS) assert.ok(pr.body.includes(file), file);

  // The same conflict again adds no commit and reuses the draft.
  const again = await sync(fixture, github);
  assert.equal(again.state.changed, false);
  assert.equal(fixture.originRef(SYNC_BRANCH), tip);
  assert.equal(github.prs.length, 1);
});

test("a person's resolution survives, and the next sync marks the same PR ready", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  fixture.masterCommit({ "README.md": "fork readme\n" }, "fork: readme");
  const target = fixture.upstreamCommit({ "README.md": "upstream readme\n" }, "upstream: readme");
  await sync(fixture, github);
  assert.equal(github.prs[0].draft, true);

  const human = fixture.humanClone();
  fixture.run(human, ["merge", "--quiet", target], { allowFailure: true });
  fixture.write(human, { "README.md": "resolved\n", [REPORT_PATH]: null });
  fixture.run(human, ["commit", "--quiet", "--no-edit"]);
  fixture.run(human, ["push", "--quiet", "origin", SYNC_BRANCH]);
  const resolved = fixture.out(human, ["rev-parse", "HEAD"]);

  const next = fixture.upstreamCommit({ "NEW.md": "new\n" }, "upstream: new file");
  const result = await sync(fixture, github);
  assert.equal(result.state.status, "clean");
  const tip = fixture.originRef(SYNC_BRANCH);
  fixture.run(fixture.root, [
    "--git-dir",
    fixture.origin,
    "merge-base",
    "--is-ancestor",
    resolved,
    tip,
  ]);
  fixture.run(fixture.root, [
    "--git-dir",
    fixture.origin,
    "merge-base",
    "--is-ancestor",
    next,
    tip,
  ]);
  assert.equal(github.prs.length, 1);
  assert.equal(github.prs[0].draft, false);
  assert.ok(github.calls.some((call) => call.query?.includes("markPullRequestReadyForReview")));
});

test("a clean run removes a report a person left behind, and later conflicts convert to draft", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  fixture.masterCommit({ "README.md": "fork readme\n" }, "fork: readme");
  const target = fixture.upstreamCommit({ "README.md": "upstream readme\n" }, "upstream: readme");
  await sync(fixture, github);

  // Resolved but forgot to delete the report.
  const human = fixture.humanClone();
  fixture.run(human, ["merge", "--quiet", target], { allowFailure: true });
  fixture.write(human, { "README.md": "resolved\n" });
  fixture.run(human, ["commit", "--quiet", "--no-edit"]);
  fixture.run(human, ["push", "--quiet", "origin", SYNC_BRANCH]);
  await sync(fixture, github);
  const tip = fixture.originRef(SYNC_BRANCH);
  const ls = fixture.out(fixture.root, [
    "--git-dir",
    fixture.origin,
    "ls-tree",
    "--name-only",
    "-r",
    tip,
  ]);
  assert.ok(!ls.split("\n").includes(REPORT_PATH));
  assert.equal(github.prs[0].draft, false);

  fixture.masterCommit({ "README.md": "fork again\n" }, "fork: readme again");
  fixture.upstreamCommit({ "README.md": "upstream again\n" }, "upstream: readme again");
  const result = await sync(fixture, github);
  assert.equal(result.state.status, "conflict");
  assert.equal(github.prs.length, 1);
  assert.equal(github.prs[0].draft, true);
  assert.ok(github.calls.some((call) => call.query?.includes("convertPullRequestToDraft")));
});

test("a conflict merging master into the sync branch is reported without trying upstream", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  fixture.upstreamCommit({ "NEW.md": "new\n" }, "upstream: new");
  await sync(fixture, github);

  const human = fixture.humanClone();
  fixture.commit(human, { "apps/web/src/components/delivery/Board.tsx": "sync edit\n" }, "human");
  fixture.run(human, ["push", "--quiet", "origin", SYNC_BRANCH]);
  const humanTip = fixture.out(human, ["rev-parse", "HEAD"]);
  fixture.masterCommit({ "apps/web/src/components/delivery/Board.tsx": "master edit\n" }, "master");
  fixture.upstreamCommit({ "NEWER.md": "newer\n" }, "upstream: newer");

  const result = await sync(fixture, github);
  assert.equal(result.state.status, "conflict");
  assert.equal(result.state.stage, "master");
  assert.deepEqual(result.state.conflicts, ["apps/web/src/components/delivery/Board.tsx"]);
  assert.ok(github.prs[0].body.includes("Upstream integration was not attempted."));
  const tip = fixture.originRef(SYNC_BRANCH);
  fixture.run(fixture.root, [
    "--git-dir",
    fixture.origin,
    "merge-base",
    "--is-ancestor",
    humanTip,
    tip,
  ]);
});

test("a sync branch that moved during the run is never overwritten", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  fixture.upstreamCommit({ "NEW.md": "new\n" }, "upstream: new");
  await sync(fixture, github);
  fixture.upstreamCommit({ "NEWER.md": "newer\n" }, "upstream: newer");

  const cwd = fixture.checkout();
  const state = prepare({
    cwd,
    forkUrl: fixture.origin,
    upstreamUrl: fixture.upstream,
    env: fixture.env,
  });
  const human = fixture.humanClone();
  fixture.commit(human, { "HUMAN.md": "human\n" }, "human: concurrent");
  fixture.run(human, ["push", "--quiet", "origin", SYNC_BRANCH]);
  const humanTip = fixture.out(human, ["rev-parse", "HEAD"]);

  assert.throws(
    () =>
      publishBranch({
        cwd,
        state,
        pushUrl: fixture.origin,
        token: TOKEN,
        env: fixture.env,
        log() {},
      }),
    /not overwritten/,
  );
  assert.equal(fixture.originRef(SYNC_BRANCH), humanTip);
});

test("the range starts at the newest first-parent upstream commit master contains", () => {
  const fixture = createFixture();
  fixture.upstreamCommit({ "a.txt": "a\n" }, "u1");
  fixture.forkFromUpstream();
  // Upstream merges a side branch, so its first-parent chain has a merge.
  fixture.run(fixture.up, ["checkout", "--quiet", "-b", "side"]);
  const side = fixture.commit(fixture.up, { "side.txt": "side\n" }, "side");
  fixture.run(fixture.up, ["checkout", "--quiet", "main"]);
  const u2 = fixture.commit(fixture.up, { "b.txt": "b\n" }, "u2");
  fixture.run(fixture.up, ["merge", "--quiet", "--no-ff", "-m", "merge side", "side"]);
  fixture.run(fixture.up, ["push", "--quiet", "origin", "main"]);
  // The fork merged u2 earlier, and separately the side commit.
  fixture.run(fixture.fork, ["fetch", "--quiet", "upstream"]);
  fixture.run(fixture.fork, ["merge", "--quiet", "--no-edit", u2]);
  fixture.run(fixture.fork, ["merge", "--quiet", "--no-edit", side]);
  fixture.run(fixture.fork, ["push", "--quiet", "origin", "master"]);
  fixture.upstreamCommit({ "c.txt": "c\n" }, "u3");

  const cwd = fixture.checkout();
  fixture.run(cwd, ["fetch", "--quiet", fixture.upstream, "+refs/heads/main:refs/oracle/upstream"]);
  const chain = fixture
    .out(cwd, ["rev-list", "--first-parent", "refs/oracle/upstream"])
    .split("\n");
  const oracle = chain.find(
    (sha) =>
      fixture.run(cwd, ["merge-base", "--is-ancestor", sha, "master"], { allowFailure: true })
        .status === 0,
  );
  assert.equal(oracle, u2);
  assert.equal(findRangeStart(cwd, "refs/oracle/upstream", "master", fixture.env), oracle);
});

test("criss-cross history with several merge bases still syncs", async () => {
  const fixture = createFixture();
  fixture.upstreamCommit({ "a.txt": "a\n" }, "base");
  fixture.forkFromUpstream();
  const fork1 = fixture.masterCommit({ "fork.txt": "fork\n" }, "f1");
  const u1 = fixture.upstreamCommit({ "u.txt": "u\n" }, "u1");
  // Upstream takes the fork's commit; the fork takes upstream's.
  fixture.run(fixture.up, ["fetch", "--quiet", fixture.origin, "master"]);
  fixture.run(fixture.up, ["merge", "--quiet", "--no-edit", fork1]);
  fixture.run(fixture.up, ["push", "--quiet", "origin", "main"]);
  fixture.run(fixture.fork, ["fetch", "--quiet", "upstream"]);
  fixture.run(fixture.fork, ["merge", "--quiet", "--no-edit", u1]);
  fixture.run(fixture.fork, ["push", "--quiet", "origin", "master"]);
  const target = fixture.upstreamCommit({ "u2.txt": "u2\n" }, "u2");

  const cwd = fixture.checkout();
  fixture.run(cwd, ["fetch", "--quiet", fixture.upstream, "main"]);
  const bases = fixture.out(cwd, ["merge-base", "--all", "master", "FETCH_HEAD"]).split("\n");
  assert.equal(bases.length, 2);

  const result = await sync(fixture, createGitHub());
  assert.equal(result.state.status, "clean");
  assert.equal(result.state.rangeStart, u1);
  assert.equal(result.state.target, target);
});

test("unrelated upstream history fails clearly", () => {
  const { fixture } = baseFixture();
  fixture.run(fixture.up, ["checkout", "--quiet", "--orphan", "other"]);
  fixture.run(fixture.up, ["rm", "-r", "--quiet", "-f", "."]);
  fixture.commit(fixture.up, { "x.txt": "x\n" }, "unrelated");
  fixture.run(fixture.up, ["push", "--quiet", "-f", "origin", "other:main"]);
  const cwd = fixture.checkout();
  assert.throws(
    () =>
      prepare({ cwd, forkUrl: fixture.origin, upstreamUrl: fixture.upstream, env: fixture.env }),
    /shares no history/,
  );
  assert.equal(fixture.originRef(SYNC_BRANCH), null);
});

test("upstream taking a fork-reserved path stops the sync", () => {
  const { fixture } = baseFixture();
  fixture.upstreamCommit({ ".github/workflows/tevin-upstream-sync.yml": "x\n" }, "collide");
  const cwd = fixture.checkout();
  assert.throws(
    () =>
      prepare({ cwd, forkUrl: fixture.origin, upstreamUrl: fixture.upstream, env: fixture.env }),
    /fork-reserved/,
  );
});

test("a conflict report the automation did not write is never overwritten", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  fixture.upstreamCommit({ "NEW.md": "new\n" }, "upstream: new");
  await sync(fixture, github);
  const human = fixture.humanClone();
  fixture.commit(human, { [REPORT_PATH]: "my own notes\n" }, "human notes");
  fixture.run(human, ["push", "--quiet", "origin", SYNC_BRANCH]);
  fixture.masterCommit({ "README.md": "fork\n" }, "fork readme");
  fixture.upstreamCommit({ "README.md": "upstream\n" }, "upstream readme");
  await assert.rejects(sync(fixture, github), /without the automation marker/);
});

test("a PR create that failed after the push is retried without duplicates", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  fixture.upstreamCommit({ "NEW.md": "new\n" }, "upstream: new");
  github.failCreateOnce();
  await assert.rejects(sync(fixture, github), /502/);
  assert.ok(fixture.originRef(SYNC_BRANCH));
  const retry = await sync(fixture, github);
  assert.equal(retry.push.pushed, false);
  assert.equal(github.prs.length, 1);
  await sync(fixture, github);
  assert.equal(github.prs.length, 1);
});

test("two open sync PRs fail instead of guessing", async () => {
  const github = createGitHub();
  const pr = (number) => ({
    number,
    state: "open",
    head: { ref: SYNC_BRANCH, repo: { full_name: REPO } },
    base: { ref: "master" },
  });
  github.prs.push(pr(1), pr(2));
  const state = {
    status: "clean",
    rangeStart: "a".repeat(40),
    target: "b".repeat(40),
    commitCount: 1,
  };
  await assert.rejects(
    upsertPullRequest({ api: github.api, repo: REPO, state, log() {} }),
    /Found 2 open sync PRs/,
  );
});

// After the PR lands (or closes), the next gap must give one usable PR and keep human commits.
for (const landing of ["merge", "squash", "rebase", "close"]) {
  for (const deleteBranch of [false, true]) {
    if (landing === "close" && deleteBranch) continue;
    test(`after a ${landing}${deleteBranch ? " and branch deletion" : ""}, the next gap opens one PR`, async () => {
      const { fixture } = baseFixture();
      const github = createGitHub();
      const u1 = fixture.upstreamCommit({ "one.md": "1\n" }, "upstream one");
      const u2 = fixture.upstreamCommit({ "two.md": "2\n" }, "upstream two");
      await sync(fixture, github);
      const human = fixture.humanClone();
      const humanTip = fixture.commit(human, { "HUMAN.md": "human\n" }, "human");
      fixture.run(human, ["push", "--quiet", "origin", SYNC_BRANCH]);

      const fork = fixture.fork;
      fixture.run(fork, ["checkout", "--quiet", "master"]);
      fixture.run(fork, ["fetch", "--quiet", "origin"]);
      fixture.run(fork, ["fetch", "--quiet", "upstream"]);
      if (landing === "merge") {
        fixture.run(fork, ["merge", "--quiet", "--no-ff", "--no-edit", `origin/${SYNC_BRANCH}`]);
      } else if (landing === "squash") {
        fixture.run(fork, ["merge", "--quiet", "--squash", `origin/${SYNC_BRANCH}`]);
        fixture.run(fork, ["commit", "--quiet", "-m", "squash sync"]);
      } else if (landing === "rebase") {
        fixture.run(fork, ["cherry-pick", u1, u2, humanTip]);
      }
      fixture.run(fork, ["push", "--quiet", "origin", "master"]);
      github.prs[0].state = landing === "close" ? "closed" : "merged";
      if (deleteBranch) fixture.run(fork, ["push", "--quiet", "origin", "--delete", SYNC_BRANCH]);

      const u3 = fixture.upstreamCommit({ "three.md": "3\n" }, "upstream three");
      const result = await sync(fixture, github);
      assert.equal(result.state.status, "clean");
      const tip = fixture.originRef(SYNC_BRANCH);
      fixture.run(fixture.root, [
        "--git-dir",
        fixture.origin,
        "merge-base",
        "--is-ancestor",
        u3,
        tip,
      ]);
      if (!deleteBranch) {
        fixture.run(fixture.root, [
          "--git-dir",
          fixture.origin,
          "merge-base",
          "--is-ancestor",
          humanTip,
          tip,
        ]);
      }
      assert.equal(github.open().length, 1);
      assert.equal(github.open()[0].draft, false);
      assert.equal(github.prs.length, 2);
    });
  }
}

test("the workflow keeps the token in its two publication steps and never forces or targets master", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../workflows/tevin-upstream-sync.yml"),
    "utf8",
  );
  const helper = fs.readFileSync(path.join(__dirname, "tevin-upstream-sync.cjs"), "utf8");
  assert.match(workflow, /^ {2}schedule:\n(?: {4}#.*\n)? {4}- cron: "[^"]+"$/m);
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  assert.match(workflow, /^permissions:\n {2}contents: read\n {2}pull-requests: read\n\n/m);
  assert.doesNotMatch(workflow, /: write/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/master'/);

  const steps = workflow.split(/\n(?= {6}- )/);
  // Checkout is plain git with the read-only job token, sent per command and never saved to config.
  assert.doesNotMatch(workflow, /uses: actions\/checkout|git submodule|--recurse/);
  const checkout = steps.find((step) => /name: Checkout master/.test(step));
  assert.match(checkout, /READ_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(checkout, /git -c http\.https:\/\/github\.com\/\.extraheader=/);
  assert.doesNotMatch(checkout, /git config[^\n]*extraheader/);
  const withSecret = steps.filter((step) => step.includes("UPSTREAM_SYNC_TOKEN"));
  assert.equal(workflow.split("secrets.UPSTREAM_SYNC_TOKEN").length - 1, 2);
  assert.deepEqual(
    withSecret.map((step) => step.match(/name: (.+)/)[1]),
    ["Push sync branch", "Create or update sync PR"],
  );
  // Everything after checkout runs the copy of the helper taken from master.
  for (const step of steps.filter((step) => step.includes('tevin-upstream-sync.cjs" '))) {
    assert.match(step, /node "\$RUNNER_TEMP\/tevin-upstream-sync\.cjs"/);
  }

  const pushes = helper.match(/\["push"[^\]]*\]/g);
  assert.deepEqual(pushes, ['["push", "--no-verify", pushUrl, `HEAD:refs/heads/${SYNC_BRANCH}`]']);
  for (const source of [workflow, ...pushes]) {
    assert.doesNotMatch(source, /--force|force-with-lease|\+HEAD|\+refs/);
  }
  assert.doesNotMatch(helper, /push[^\n]*refs\/heads\/master/);
});
