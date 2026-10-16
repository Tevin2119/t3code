const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  BODY_START,
  PR_TITLE,
  REPORT_MARKER,
  REPORT_PATH,
  LEGACY_BRANCH,
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
  const temporary = path.join(__dirname, "../../.plans");
  fs.mkdirSync(temporary, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporary, "tevin-upstream-sync-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
  };
  return fixture;
}

function createGitHub() {
  const prs = [];
  const calls = [];
  const comments = [];
  let failure;
  const api = {
    async request(method, apiPath, body) {
      calls.push({ method, apiPath, body });
      if (failure && failure(method, apiPath, body)) {
        failure = null;
        throw new Error("GitHub injected failure: 502");
      }
      const [pathname, search] = apiPath.split("?");
      if (method === "GET" && pathname === `/repos/${REPO}/pulls`) {
        const query = new URLSearchParams(search);
        assert.equal(query.get("base"), "master");
        assert.equal(query.get("state"), "open");
        const filtered = prs.filter(
          (pr) =>
            pr.state === "open" &&
            pr.base.ref === query.get("base") &&
            (!query.has("head") || `Tevin2119:${pr.head.ref}` === query.get("head")),
        );
        const size = Number(query.get("per_page") ?? 30);
        const start = (Number(query.get("page") ?? 1) - 1) * size;
        return filtered.slice(start, start + size).map((pr) => ({ ...pr }));
      }
      if (method === "POST" && pathname === `/repos/${REPO}/pulls`) {
        return { ...add(body.head, body) };
      }
      const comment = pathname.match(/\/issues\/(\d+)\/comments$/);
      if (method === "POST" && comment) {
        comments.push({ number: Number(comment[1]), body: body.body });
        return {};
      }
      const update = pathname.match(/\/pulls\/(\d+)$/);
      if (method === "PATCH" && update) {
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
  function add(branch, overrides = {}) {
    const number = prs.length + 1;
    const pr = {
      number,
      node_id: `PR_${number}`,
      html_url: `https://github.com/${REPO}/pull/${number}`,
      state: "open",
      title: PR_TITLE,
      body: "",
      draft: false,
      ...overrides,
      head: { ref: branch, repo: { full_name: overrides.repo ?? REPO } },
      base: { ref: overrides.base ?? "master" },
    };
    prs.push(pr);
    return pr;
  }
  return {
    api,
    prs,
    calls,
    comments,
    add,
    failOnce(predicate) {
      failure = predicate;
    },
    open: () => prs.filter((pr) => pr.state === "open"),
  };
}

/** One workflow run: prepare, push and PR, with master checked untouched afterwards. */
async function sync(
  fixture,
  github,
  { token = TOKEN, date = "2026-10-16", cwd = fixture.checkout() } = {},
) {
  const masterBefore = fixture.originRef("master");
  const logs = [];
  const log = (line) => logs.push(line);
  const state = prepare({
    cwd,
    date,
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

const DAY = "automation/upstream-sync-2026-10-16";
const quiet = () => {};
const prepared = (fixture, cwd = fixture.checkout(), date = "2026-10-16") => ({
  cwd,
  state: prepare({
    cwd,
    date,
    forkUrl: fixture.origin,
    upstreamUrl: fixture.upstream,
    env: fixture.env,
  }),
});
const push = (fixture, candidate) =>
  publishBranch({
    ...candidate,
    pushUrl: fixture.origin,
    token: TOKEN,
    env: fixture.env,
    log: quiet,
  });
const openPr = (github, state) =>
  upsertPullRequest({ api: github.api, repo: REPO, state, log: quiet });

function assertClean(fixture, { cwd, state, pr }) {
  assert.equal(state.status, "clean");
  assert.deepEqual(fixture.out(cwd, ["show", "-s", "--format=%P", state.head]).split(" "), [
    state.base,
    state.target,
  ]);
  assert.equal(
    fixture.out(cwd, ["rev-list", "--count", state.head, `^${state.base}`, `^${state.target}`]),
    "1",
  );
  assert.equal(
    fixture.out(cwd, ["rev-list", "--first-parent", "--count", `${state.base}..${state.head}`]),
    "1",
  );
  assert.equal(
    fixture.run(cwd, ["cat-file", "-e", `${state.head}:${REPORT_PATH}`], { allowFailure: true })
      .status,
    128,
  );
  assert.doesNotMatch(
    fixture.out(cwd, ["log", "--format=%s", state.head, `^${state.base}`, `^${state.target}`]),
    /report upstream sync conflicts|remove resolved/,
  );
  assert.equal(
    fixture.run(cwd, ["symbolic-ref", "-q", "HEAD"], { allowFailure: true }).stdout.trim(),
    "",
  );
  assert.equal(fixture.originRef(state.branch), state.head);
  if (pr) {
    assert.equal(pr.draft, false);
    assert.equal(pr.head.ref, state.branch);
  }
}

test("noop and missing token never publish", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  for (let i = 0; i < 2; i += 1) {
    const result = await sync(fixture, github);
    assert.equal(result.state.status, "noop");
    assert.equal(result.push.pushed, false);
    assert.equal(result.pr, null);
  }
  await assert.rejects(sync(fixture, github, { token: "" }), /UPSTREAM_SYNC_TOKEN/);
  fixture.upstreamCommit({ "new.md": "new\n" }, "new");
  await assert.rejects(sync(fixture, github, { token: null }), /UPSTREAM_SYNC_TOKEN/);
  assert.equal(fixture.originRef(DAY), null);
  assert.deepEqual(github.calls, []);
});

for (const fastForward of [false, true]) {
  test(`clean ${fastForward ? "fast-forwardable" : "divergent"} history publishes exactly a merge`, async () => {
    const { fixture, base } = baseFixture();
    if (fastForward) {
      fixture.run(fixture.fork, ["checkout", "--quiet", "-B", "master", base]);
      // An isolated fixture origin with no fork-only commits yet.
      fixture.run(fixture.fork, ["push", "--quiet", "--force", "origin", "master"]);
    }
    const github = createGitHub();
    fixture.upstreamCommit({ "README.md": "upstream 2\n" }, "upstream 2");
    const target = fixture.upstreamCommit(
      { ".github/workflows/ci.yml": "name: CI\non: pull_request\n" },
      "upstream ci",
    );
    const result = await sync(fixture, github);
    assertClean(fixture, result);
    assert.equal(result.state.branch, DAY);
    assert.equal(result.state.rangeStart, base);
    assert.equal(result.state.target, target);
    assert.equal(result.state.commitCount, 2);
    assert.ok(result.pr.body.includes(`compare/${base}...${target}`));
    assert.equal(
      fixture.out(result.cwd, ["show", "HEAD:.github/workflows/ci.yml"]),
      "name: CI\non: pull_request",
    );
    github.prs[0].body = `Reviewer notes.\n\n${github.prs[0].body}\nFooter.`;
    await openPr(github, JSON.parse(JSON.stringify(result.state)));
    assert.equal(github.prs.length, 1);
    assert.match(github.prs[0].body, /^Reviewer notes\./);
    assert.match(github.prs[0].body, /Footer\.$/);
    assert.equal(github.prs[0].body.split(BODY_START).length, 2);
  });
}

test("true conflicts match merge-tree exactly and leave only a report above captured master", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  const base = fixture.masterCommit(
    Object.fromEntries(ODD_PATHS.map((file) => [file, "fork\n"])),
    "fork edits",
  );
  const target = fixture.upstreamCommit(
    Object.fromEntries(ODD_PATHS.map((file) => [file, "upstream\n"])),
    "upstream edits",
  );
  const result = await sync(fixture, github);
  const { cwd, state, pr } = result;
  const expected = mergeTreeConflicts(fixture, cwd, base, target);
  assert.deepEqual(expected, [...ODD_PATHS].sort());
  assert.deepEqual(state.conflicts, expected);
  assert.equal(state.status, "conflict");
  assert.equal(pr.draft, true);
  assert.equal(pr.head.ref, DAY);
  assert.equal(fixture.out(cwd, ["show", "-s", "--format=%P", state.head]), base);
  assert.equal(fixture.out(cwd, ["diff", "--name-only", base, state.head]), REPORT_PATH);
  assert.equal(fixture.out(cwd, ["ls-files", "-u"]), "");
  for (const file of ODD_PATHS)
    assert.equal(fs.readFileSync(path.join(cwd, file), "utf8"), "fork\n");
  const report = fs.readFileSync(path.join(cwd, REPORT_PATH), "utf8");
  assert.ok(report.startsWith(REPORT_MARKER));
  assert.deepEqual(
    report.split("\n").filter((line) => line.startsWith("- `")),
    expected.map((file) => `- ${require("./tevin-upstream-sync.cjs").codeSpan(file)}`),
  );
  assert.doesNotMatch(
    fixture.out(cwd, ["diff", base, state.head]),
    /\+<<<<<<<|\+=======|\+>>>>>>>/,
  );
  assert.match(pr.body, new RegExp(DAY));
});

test("fresh fetched master ignores stale legacy report history and a stale runner checkout", async () => {
  const { fixture } = baseFixture();
  const cwd = fixture.checkout();
  const stale = fixture.out(cwd, ["rev-parse", "HEAD"]);
  fixture.run(fixture.fork, ["checkout", "--quiet", "-b", LEGACY_BRANCH]);
  fixture.commit(
    fixture.fork,
    { [REPORT_PATH]: `${REPORT_MARKER}\nold report\n`, "README.md": "legacy edit\n" },
    "chore: report upstream sync conflicts",
  );
  fixture.run(fixture.fork, ["push", "--quiet", "origin", LEGACY_BRANCH]);
  const legacy = fixture.originRef(LEGACY_BRANCH);
  const base = fixture.masterCommit({ "README.md": "new master\n" }, "advance master");
  fixture.upstreamCommit({ "new.md": "new upstream\n" }, "advance upstream");
  const github = createGitHub();
  const old = github.add(LEGACY_BRANCH);
  const result = await sync(fixture, github, { cwd });
  assert.notEqual(stale, base);
  assert.equal(result.state.base, base);
  assertClean(fixture, result);
  assert.equal(old.state, "closed");
  assert.equal(fixture.originRef(LEGACY_BRANCH), legacy);
  assert.ok(github.comments[0].body.includes(result.pr.html_url));
});

test("two UTC days use each fetched master and close the prior PR after a superseded note", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  fixture.upstreamCommit({ "new.md": "new\n" }, "new");
  const first = await sync(fixture, github, { date: "2026-10-16T23:30:00-01:00" });
  assert.equal(first.state.branch, "automation/upstream-sync-2026-10-17");
  const base = fixture.masterCommit({ "later.md": "later\n" }, "master advances");
  const second = await sync(fixture, github, { date: "2026-10-18" });
  assertClean(fixture, first);
  assertClean(fixture, second);
  assert.equal(second.state.base, base);
  assert.notEqual(first.state.base, base);
  assert.equal(github.open().length, 1);
  assert.equal(github.prs[0].state, "closed");
  const creation = github.calls.findIndex(
    (call) => call.method === "POST" && call.body.head === second.state.branch,
  );
  const comment = github.calls.findIndex((call) => call.apiPath?.endsWith("/issues/1/comments"));
  const closure = github.calls.findIndex(
    (call) => call.method === "PATCH" && call.body.state === "closed",
  );
  assert.ok(creation < comment && comment < closure);
  assert.match(github.comments[0].body, /Superseded/);
  assert.ok(github.comments[0].body.includes(second.pr.html_url));
});

test("same-day local and remote collisions use numeric suffixes without checking out held branches", async () => {
  const { fixture } = baseFixture();
  const github = createGitHub();
  fixture.upstreamCommit({ "new.md": "new\n" }, "new");
  const first = await sync(fixture, github);
  const held = path.join(fixture.root, "held");
  fixture.run(first.cwd, ["branch", DAY, first.state.head]);
  fixture.run(first.cwd, ["worktree", "add", "--quiet", held, DAY]);
  fixture.run(first.cwd, ["branch", `${DAY}-1`, first.state.base]);
  const content = fs.readFileSync(path.join(held, "README.md"), "utf8");
  const second = await sync(fixture, github, { cwd: first.cwd });
  assert.equal(second.state.branch, `${DAY}-2`);
  assertClean(fixture, second);
  assert.equal(fixture.out(held, ["symbolic-ref", "--short", "HEAD"]), DAY);
  assert.equal(fixture.out(held, ["rev-parse", "HEAD"]), first.state.head);
  assert.equal(fixture.out(first.cwd, ["rev-parse", DAY]), first.state.head);
  assert.equal(fs.readFileSync(path.join(held, "README.md"), "utf8"), content);
  assert.equal(fixture.out(held, ["status", "--porcelain"]), "");
  const third = await sync(fixture, github);
  assert.equal(third.state.branch, `${DAY}-3`);
  assertClean(fixture, third);
  assert.equal(github.prs[0].state, "closed");
  assert.equal(github.prs[1].state, "closed");
  assert.deepEqual(
    github.open().map((pr) => pr.number),
    [third.pr.number],
  );
  assert.ok(
    github.comments.some(
      (comment) =>
        comment.number === second.pr.number &&
        comment.body.includes("Superseded") &&
        comment.body.includes(third.pr.html_url),
    ),
  );
  assert.equal(fixture.originRef(first.state.branch), first.state.head);
  assert.equal(fixture.originRef(second.state.branch), second.state.head);
  assert.equal(fixture.out(first.cwd, ["rev-parse", `${DAY}-1`]), first.state.base);
  assert.equal(fixture.out(held, ["symbolic-ref", "--short", "HEAD"]), DAY);
  assert.equal(fixture.out(held, ["rev-parse", "HEAD"]), first.state.head);
  assert.equal(fs.readFileSync(path.join(held, "README.md"), "utf8"), content);
  assert.equal(fixture.out(held, ["status", "--porcelain"]), "");
});

test("a concurrent divergent remote branch rejects the plain push and keeps the remote tip", () => {
  const { fixture } = baseFixture();
  fixture.upstreamCommit({ "new.md": "new\n" }, "new");
  const candidate = prepared(fixture);
  const human = fixture.checkout();
  const humanTip = fixture.commit(human, { "human.md": "concurrent\n" }, "concurrent");
  fixture.run(human, ["push", "--quiet", "origin", `HEAD:refs/heads/${candidate.state.branch}`]);
  assert.throws(() => push(fixture, candidate), /not overwritten/);
  assert.equal(fixture.originRef(candidate.state.branch), humanTip);
});

for (const operation of ["create", "comment", "close"]) {
  test(`${operation} failure surfaces and same-state PR retry completes supersession`, async () => {
    const { fixture } = baseFixture();
    fixture.upstreamCommit({ "new.md": "new\n" }, "new");
    const github = createGitHub();
    const old = github.add(LEGACY_BRANCH);
    const candidate = prepared(fixture);
    push(fixture, candidate);
    const state = JSON.parse(JSON.stringify(candidate.state));
    github.failOnce((method, apiPath, body) =>
      operation === "create"
        ? method === "POST" && apiPath.endsWith("/pulls")
        : operation === "comment"
          ? apiPath.endsWith("/comments")
          : body?.state === "closed",
    );
    await assert.rejects(openPr(github, state), /502/);
    assert.equal(old.state, "open");
    if (operation === "create") assert.equal(github.comments.length, 0);
    else github.prs[1].body = `Reviewer text\n${github.prs[1].body}`;
    await openPr(github, state);
    assert.equal(github.prs.length, 2);
    assert.equal(old.state, "closed");
    if (operation !== "create") assert.match(github.prs[1].body, /^Reviewer text/);
    assert.equal(fixture.originRef(state.branch), state.head);
  });
}

test("snapshot all shrinking open-PR pages before closing only exact older sync branches", async () => {
  const github = createGitHub();
  for (let i = 1; i <= 205; i += 1) github.add(`automation/upstream-sync-2026-10-15-${i}`);
  const legacy = github.add(LEGACY_BRANCH);
  const preserved = [
    github.add("automation/upstream-sync-2026-10-17"),
    github.add(`${DAY}-9`),
    github.add(`${DAY}-01`),
    github.add("automation/upstream-sync-2026-10-15-extra"),
    github.add("feature/unrelated"),
    github.add(LEGACY_BRANCH, { repo: "someone/t3code" }),
    github.add(LEGACY_BRANCH, { base: "main" }),
  ];
  const state = {
    status: "clean",
    branch: DAY,
    rangeStart: "a".repeat(40),
    target: "b".repeat(40),
    commitCount: 1,
  };
  const replacement = await openPr(github, state);
  assert.equal(legacy.state, "closed");
  assert.ok(github.prs.slice(0, 205).every((pr) => pr.state === "closed"));
  assert.ok(preserved.every((pr) => pr.state === "open"));
  assert.equal(github.prs.at(-1).state, "open");
  assert.equal(github.comments.length, 206);
  assert.ok(github.comments.every((comment) => comment.body.includes(replacement.html_url)));
  const pages = github.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.method === "GET" && call.apiPath.includes("per_page=100"));
  assert.equal(pages.length, 3);
  const firstMutation = github.calls.findIndex((call) => call.apiPath.endsWith("/comments"));
  assert.ok(pages.every(({ index }) => index < firstMutation));
});

test("same-state retry changes draft state through GraphQL and rejects ambiguous matches", async () => {
  const github = createGitHub();
  const state = {
    status: "clean",
    branch: DAY,
    rangeStart: "a".repeat(40),
    target: "b".repeat(40),
    commitCount: 1,
  };
  await openPr(github, state);
  await openPr(github, { ...state, status: "conflict", conflicts: ["a.txt"] });
  assert.equal(github.prs[0].draft, true);
  await openPr(github, state);
  assert.equal(github.prs[0].draft, false);
  github.add(DAY);
  await assert.rejects(openPr(github, state), /Found 2 open sync PRs/);
});

test("reserved paths, unrelated histories, and unowned master reports stop safely", () => {
  for (const kind of ["reserved", "unrelated", "unowned"]) {
    const { fixture } = baseFixture();
    if (kind === "reserved")
      fixture.upstreamCommit({ ".github/workflows/tevin-upstream-sync.yml": "x\n" }, "reserved");
    if (kind === "unrelated") {
      fixture.run(fixture.up, ["checkout", "--quiet", "--orphan", "other"]);
      fixture.run(fixture.up, ["rm", "-r", "--quiet", "-f", "."]);
      fixture.commit(fixture.up, { "x.txt": "x\n" }, "unrelated");
      fixture.run(fixture.up, ["push", "--quiet", "--force", "origin", "other:main"]);
    }
    if (kind === "unowned") {
      fixture.masterCommit({ [REPORT_PATH]: "human notes\n" }, "notes");
      fixture.upstreamCommit({ "new.md": "new\n" }, "new");
    }
    assert.throws(
      () => prepared(fixture),
      /fork-reserved|shares no history|without the automation marker/,
    );
    assert.equal(fixture.originRef(DAY), null);
  }
});

test("owned report on master is removed inside the one clean merge commit", async () => {
  const { fixture } = baseFixture();
  fixture.masterCommit({ [REPORT_PATH]: `${REPORT_MARKER}\nold\n` }, "landed report");
  fixture.upstreamCommit({ "new.md": "new\n" }, "new");
  assertClean(fixture, await sync(fixture, createGitHub()));
});

test("non-conflict merge errors fail instead of opening a report", () => {
  const { fixture } = baseFixture();
  fixture.upstreamCommit({ "new.md": "new\n" }, "new");
  const cwd = fixture.checkout();
  fs.writeFileSync(path.join(cwd, "new.md"), "untracked obstruction\n");
  assert.throws(() => prepared(fixture, cwd), /failed without conflicts/);
  assert.equal(fs.existsSync(path.join(cwd, REPORT_PATH)), false);
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

  const testIndex = workflow.indexOf("node --test .github/scripts/tevin-upstream-sync.test.cjs");
  const copyIndex = workflow.indexOf(
    'cp .github/scripts/tevin-upstream-sync.cjs "$RUNNER_TEMP/tevin-upstream-sync.cjs"',
  );
  const prepareIndex = workflow.indexOf('node "$RUNNER_TEMP/tevin-upstream-sync.cjs" prepare');
  assert.ok(testIndex > 0 && testIndex < copyIndex && copyIndex < prepareIndex);

  const pushes = helper.match(/\["push"[^\]]*\]/g);
  assert.deepEqual(pushes, ['["push", "--no-verify", pushUrl, `HEAD:refs/heads/${state.branch}`]']);
  for (const source of [workflow, ...pushes]) {
    assert.doesNotMatch(source, /--force|force-with-lease|\+HEAD|\+refs/);
  }
  assert.doesNotMatch(helper, /push[^\n]*refs\/heads\/master/);
});
