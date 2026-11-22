#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalJsonInEffect:off - A host-side helper process for one test; plain Node keeps it readable beside the engine's own code.
// Runs a real delivery engine (a checkout of Operation-PaperClip) for
// src/delivery/BoardTaskThreads.engine.test.ts, which starts it. Everything it writes is under a
// temp folder: a home, a git repository bound as "app", and one board, "work". No worker ever
// runs. It prints one JSON line, {engine, control, repo}, then serves until POST /stop.
//
//   node scripts/board-thread-engine.ts <engine checkout>
//
// T3_BOARD_THREAD_ENGINE_PHRASE is the approval passphrase the engine is seeded with; the board
// thread write is refused without it. The control port does what the engine's API does not offer
// a test: adding a task in a chosen state, moving one, deleting one, and reading its events.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const engineRoot = NodePath.resolve(process.argv[2] ?? "");
const phrase = process.env.T3_BOARD_THREAD_ENGINE_PHRASE ?? "";
if (!NodeFS.existsSync(NodePath.join(engineRoot, "delivery/lib/api.mjs")) || phrase === "") {
  console.error(
    "usage: T3_BOARD_THREAD_ENGINE_PHRASE=<phrase> board-thread-engine.ts <engine checkout>",
  );
  process.exit(2);
}
const load = (file: string) => import(NodeURL.pathToFileURL(NodePath.join(engineRoot, file)).href);
const { createApi } = await load("delivery/lib/api.mjs");
const { createEngine } = await load("delivery/test/fixtures/engine.mjs");
const { writeApproval } = await load("delivery/lib/approval.mjs");
const { placeTask, saveSets } = await load("delivery/lib/sets.mjs");

// A git hook's variables would point the scratch repository at the caller's.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
);
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bt-"));
const home = NodePath.join(root, "home");
const repo = NodePath.join(root, "repo");
NodeFS.mkdirSync(home);
NodeFS.mkdirSync(repo);
for (const args of [
  ["init", "-b", "main"],
  [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "base",
  ],
]) {
  NodeChildProcess.execFileSync("git", args, { cwd: repo, stdio: "ignore", env });
}
NodeFS.writeFileSync(
  NodePath.join(home, "repositories.json"),
  JSON.stringify({ repositories: { app: { path: repo, title: "App", defaultBase: "main" } } }),
);
saveSets(home, {
  sets: { work: { title: "Work", repository: "app", base: "main", tasks: [] } },
  views: {},
});
await writeApproval(home, phrase);

const engine = createEngine({
  home,
  repoRoot: repo,
  teamsFolder: NodePath.join(engineRoot, "teams"),
  options: { freeMemoryMb: () => 8000 },
  runWorker: async () => {
    throw new Error("no runs expected");
  },
});
const api = createApi(engine);
await api.ready;
await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));

const control = NodeHttp.createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : {};
  let out: unknown = {};
  try {
    if (request.url === "/add") {
      const { board = "work", ...rest } = body;
      const task = engine.store.addTask({
        title: "Task",
        body: "Body",
        team: "development",
        ...rest,
      });
      if (board) placeTask(home, engine.store, task.id, board, { by: "scratch" });
      out = task;
    } else if (request.url === "/move") {
      out = engine.store.moveTask(body.id, body.state);
    } else if (request.url === "/delete") {
      // The engine has no delete on its API; these are the rows a task owns.
      engine.store.write("delete from task_board_threads where task = ?", body.id);
      engine.store.write("delete from orchestration_leases where task = ?", body.id);
      engine.store.write("delete from tasks where id = ?", body.id);
    } else if (request.url === "/events") {
      out = engine.store
        .events({ task: body.id })
        .map((event: { kind: string; data: unknown }) => ({ kind: event.kind, data: event.data }));
    } else if (request.url === "/stop") {
      response.end("{}");
      api.beginShutdown();
      await new Promise((resolve) => api.server.close(resolve));
      await engine.interrupt();
      engine.store.close();
      NodeFS.rmSync(root, { recursive: true, force: true });
      process.exit(0);
    }
    response.end(JSON.stringify(out ?? {}));
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
const port = (server: NodeHttp.Server) => (server.address() as { port: number }).port;
console.log(
  JSON.stringify({
    engine: `http://127.0.0.1:${port(api.server)}`,
    control: `http://127.0.0.1:${port(control)}`,
    repo,
  }),
);
