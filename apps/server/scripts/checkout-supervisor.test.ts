// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - drives the launcher with fake processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import type { SupervisorMessage } from "../src/checkoutUpdate/protocol.ts";
import {
  CheckoutSupervisor,
  RESTART_LIMIT,
  RESTART_WINDOW_MS,
  type ExecResult,
  type ServerProcess,
} from "./checkout-supervisor.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

class FakeServer extends NodeEvents.EventEmitter implements ServerProcess {
  connected = true;
  readonly sent: SupervisorMessage[] = [];
  readonly signals: string[] = [];
  readonly releaseDir: string;
  readonly prepareReply: "ready" | "fail" | "none";
  constructor(releaseDir: string, prepareReply: "ready" | "fail" | "none" = "ready") {
    super();
    this.releaseDir = releaseDir;
    this.prepareReply = prepareReply;
  }
  send(message: SupervisorMessage) {
    this.sent.push(message);
    this.emit("sent", message);
    // A server prepares as soon as it is asked.
    if (message.type === "t3-checkout.prepare" && this.prepareReply !== "none") {
      queueMicrotask(() =>
        this.emit(
          "message",
          this.prepareReply === "ready"
            ? { type: "t3-checkout.prepared", threads: 1 }
            : { type: "t3-checkout.preparation-failed" },
        ),
      );
    }
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    this.connected = false;
    queueMicrotask(() => this.emit("exit", null, signal));
  }
  ready() {
    this.emit("message", { type: "t3-checkout.ready" });
  }
}

const directories: string[] = [];
const supervisors: CheckoutSupervisor[] = [];
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop("SIGTERM");
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    const absolute = NodePath.resolve(directory);
    expect(absolute.startsWith(`${NodePath.resolve(NodeOS.tmpdir())}${NodePath.sep}`)).toBe(true);
    expect(NodePath.basename(absolute).startsWith("checkout-supervisor-")).toBe(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function setup(input: {
  readonly ahead?: boolean;
  readonly buildFails?: boolean;
  readonly prepareReply?: "ready" | "fail" | "none";
  readonly prepareMs?: number;
  readonly restartMs?: number;
  readonly now?: () => Date;
  readonly beforeBuild?: () => Promise<void>;
  /** Whether a server started from this release reports ready. */
  readonly startsFrom?: (releaseDir: string) => boolean;
}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkout-supervisor-"));
  directories.push(root);
  const releases = NodePath.join(root, "releases");
  const baseDir = NodePath.join(root, "data");
  const logs: string[] = [];
  const checked = Promise.withResolvers<void>();
  const commands: string[] = [];
  const servers: FakeServer[] = [];
  const exec = async (command: string, args: readonly string[]): Promise<ExecResult> => {
    const line = [command, ...args.filter((arg) => arg !== "-C" && !arg.startsWith(root))].join(
      " ",
    );
    commands.push(line);
    if (command === "git") {
      const git = args.slice(2);
      if (git[0] === "rev-parse") return { code: 0, output: git[1] === "HEAD" ? A : B };
      if (git[0] === "log")
        return { code: 0, output: git.at(-1) === B ? "Newer work" : "Older work" };
      if (git[0] === "merge-base") return { code: input.ahead === false ? 1 : 0, output: "" };
      if (git[0] === "rev-list") return { code: 0, output: "3" };
      if (git[0] === "worktree" && git[1] === "add") NodeFS.mkdirSync(git[3]!, { recursive: true });
      return { code: 0, output: "" };
    }
    if (args.includes("build")) await input.beforeBuild?.();
    if (input.buildFails && args.includes("build"))
      return { code: 1, output: "vite: something broke" };
    return { code: 0, output: "" };
  };
  const supervisor = new CheckoutSupervisor({
    source: root,
    remote: "origin",
    branch: "master",
    releases,
    baseDir,
    exec,
    log: (line) => logs.push(line),
    ...(input.now ? { now: input.now } : {}),
    timeouts: {
      prepareMs: input.prepareMs ?? 1_000,
      stopMs: 1_000,
      readyMs: 200,
      restartMs: input.restartMs ?? 0,
    },
    startServer: (releaseDir) => {
      const server = new FakeServer(releaseDir, input.prepareReply);
      servers.push(server);
      server.on("sent", (message: SupervisorMessage) => {
        if (
          message.type === "t3-checkout.state" &&
          message.state.checkedAt &&
          message.state.phase === "idle"
        ) {
          checked.resolve();
        }
      });
      if (input.startsFrom?.(releaseDir) ?? true) queueMicrotask(() => server.ready());
      return server;
    },
  });
  supervisors.push(supervisor);
  const pointer = () =>
    JSON.parse(NodeFS.readFileSync(NodePath.join(baseDir, "checkout-release.json"), "utf8")).commit;
  return { supervisor, servers, commands, releases, pointer, logs, checked: checked.promise };
}

/** Starts the supervisor and waits for its first check to finish. */
async function started(context: ReturnType<typeof setup>) {
  void context.supervisor.run();
  await context.checked;
}

describe("CheckoutSupervisor", () => {
  it.each(["fail", "none"] as const)(
    "keeps the current server when restart preparation is %s",
    async (prepareReply) => {
      const context = setup({ prepareReply, prepareMs: 0 });
      await started(context);
      await context.supervisor.update();
      expect(context.servers).toHaveLength(1);
      expect(context.servers[0]?.signals).toEqual([]);
      expect(context.logs.filter((line) => line.includes("Server exited"))).toEqual([]);
      expect(context.pointer()).toBe(A);
      expect(context.supervisor.snapshot()).toMatchObject({
        phase: "failed",
        running: { commit: A },
      });
    },
  );
  it("builds the newer commit beside the running one, then swaps the server for it", async () => {
    const context = setup({});
    await started(context);
    expect(context.supervisor.snapshot().available).toEqual({
      commit: B,
      subject: "Newer work",
      behind: 3,
    });

    await context.supervisor.update();

    const [old, replacement] = context.servers;
    expect(old?.sent.some((message) => message.type === "t3-checkout.prepare")).toBe(true);
    expect(old?.signals).toEqual(["SIGTERM"]);
    expect(replacement?.releaseDir).toBe(NodePath.join(context.releases, B));
    expect(context.commands).toContain("pnpm install --frozen-lockfile --prefer-offline");
    expect(context.servers).toHaveLength(2);
    expect(context.logs.filter((line) => line.includes("Server exited"))).toEqual([]);
    expect(context.pointer()).toBe(B);
    expect(context.supervisor.snapshot()).toMatchObject({
      running: { commit: B, subject: "Newer work" },
      available: null,
      phase: "idle",
      lastOutcome: { from: A, to: B, status: "updated" },
    });
  });

  it("goes back to the running commit when the new one does not start", async () => {
    const context = setup({ startsFrom: (releaseDir) => !releaseDir.endsWith(B) });
    await started(context);

    await context.supervisor.update();

    expect(context.servers.map((server) => NodePath.basename(server.releaseDir))).toEqual([
      A,
      B,
      A,
    ]);
    expect(context.logs.filter((line) => line.includes("Server exited"))).toEqual([]);
    expect(context.pointer()).toBe(A);
    expect(context.supervisor.snapshot()).toMatchObject({
      running: { commit: A },
      phase: "failed",
      lastOutcome: { from: A, to: B, status: "rolled-back" },
    });
  });

  it("leaves the running server alone when the new commit does not build", async () => {
    const failing = setup({ buildFails: true });
    // The running release is built already; only the newer one fails.
    NodeFS.mkdirSync(NodePath.join(failing.releases, A), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(failing.releases, A, ".t3-release-ready"), A);
    await started(failing);

    await failing.supervisor.update();

    expect(failing.servers).toHaveLength(1);
    expect(failing.servers[0]?.signals).toEqual([]);
    expect(failing.logs.filter((line) => line.includes("Server exited"))).toEqual([]);
    expect(failing.supervisor.snapshot().phase).toBe("failed");
    expect(failing.supervisor.snapshot().message).toContain("vite: something broke");
  });

  it("never offers a commit that is not after the running one", async () => {
    const context = setup({ ahead: false });
    await started(context);
    expect(context.supervisor.snapshot().available).toBeNull();
  });
});

describe("CheckoutSupervisor crash recovery", () => {
  it.each([
    [3, null, "exit code 3"],
    [null, "SIGKILL", "signal SIGKILL"],
  ] as const)(
    "restarts the same release after code %s and signal %s",
    async (code, signal, description) => {
      vi.useFakeTimers();
      const context = setup({ restartMs: 100 });
      await started(context);
      const finished = vi.fn();
      void context.supervisor.finished.then(finished);
      context.servers[0]!.emit("exit", code, signal);
      expect(context.servers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(context.servers.map((server) => NodePath.basename(server.releaseDir))).toEqual([A, A]);
      expect(context.logs).toContain(`Server exited (${description}); restarting (1/5).`);
      expect(finished).not.toHaveBeenCalled();
    },
  );

  it("gives up after five restarts within the window", async () => {
    vi.useFakeTimers();
    const context = setup({});
    await started(context);
    for (let attempt = 0; attempt < RESTART_LIMIT; attempt++) {
      context.servers.at(-1)!.emit("exit", 3, null);
      await vi.advanceTimersByTimeAsync(0);
    }
    context.servers.at(-1)!.emit("exit", 3, null);
    expect(await context.supervisor.finished).toBe(3);
    expect(context.servers).toHaveLength(1 + RESTART_LIMIT);
    expect(context.logs.filter((line) => line.includes("; restarting"))).toHaveLength(
      RESTART_LIMIT,
    );
    expect(context.logs).toContain(
      `Server exited (exit code 3); giving up after ${RESTART_LIMIT} restarts in ${RESTART_WINDOW_MS}ms.`,
    );
  });

  it("renews the restart allowance after the sliding window", async () => {
    vi.useFakeTimers();
    let now = 0;
    const context = setup({ now: () => new Date(now) });
    await started(context);
    for (let attempt = 0; attempt < RESTART_LIMIT; attempt++) {
      context.servers.at(-1)!.emit("exit", 3, null);
      await vi.advanceTimersByTimeAsync(0);
    }
    now += RESTART_WINDOW_MS + 1;
    const finished = vi.fn();
    void context.supervisor.finished.then(finished);
    context.servers.at(-1)!.emit("exit", 3, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(context.servers).toHaveLength(2 + RESTART_LIMIT);
    expect(context.logs.at(-1)).toBe("Server exited (exit code 3); restarting (1/5).");
    expect(finished).not.toHaveBeenCalled();
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "does not restart a live server stopped by %s",
    async (signal) => {
      vi.useFakeTimers();
      const context = setup({});
      await started(context);
      await context.supervisor.stop(signal);
      expect(await context.supervisor.finished).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(context.servers).toHaveLength(1);
      expect(context.servers[0]!.signals).toEqual([signal]);
      expect(context.logs.filter((line) => line.includes("Server exited"))).toEqual([]);
    },
  );

  it("cancels a restart when stopped during the delay", async () => {
    vi.useFakeTimers();
    const context = setup({ restartMs: 10_000 });
    await started(context);
    context.servers[0]!.emit("exit", 3, null);
    await context.supervisor.stop("SIGTERM");
    expect(await context.supervisor.finished).toBe(130);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(context.servers).toHaveLength(1);
    expect(context.logs).toContain("Server exited (exit code 3).");
    expect(context.logs.filter((line) => line.includes("; restarting"))).toEqual([]);
  });

  it.each([false, true])(
    "records a crash during preparation and respects a following stop: %s",
    async (stop) => {
      vi.useFakeTimers();
      const context = setup({ prepareMs: 100, prepareReply: "none" });
      await started(context);
      const server = context.servers[0]!;
      const preparing = Promise.withResolvers<void>();
      server.on("sent", (message: SupervisorMessage) => {
        if (message.type === "t3-checkout.prepare") preparing.resolve();
      });
      const finished = vi.fn();
      void context.supervisor.finished.then(finished);
      const updating = context.supervisor.update();
      await preparing.promise;
      server.emit("exit", 3, null);
      expect(context.logs).toContain("Server exited (exit code 3) during an update.");
      if (stop) {
        await context.supervisor.stop("SIGTERM");
        expect(await context.supervisor.finished).toBe(130);
      }
      await vi.advanceTimersByTimeAsync(100);
      await updating;
      expect(context.servers.map((child) => NodePath.basename(child.releaseDir))).toEqual(
        stop ? [A] : [A, A],
      );
      expect(context.logs.filter((line) => line.includes("; restarting"))).toEqual(
        stop ? [] : ["Server exited (exit code 3); restarting (1/5)."],
      );
      expect(context.pointer()).toBe(A);
      expect(context.supervisor.snapshot()).toMatchObject({
        running: { commit: A },
        phase: "failed",
        message: expect.stringContaining("did not confirm restart preparation"),
      });
      if (!stop) expect(finished).not.toHaveBeenCalled();
    },
  );

  it.each(["send", "error"] as const)(
    "survives an IPC %s failure before the dying child's exit is delivered",
    async (failure) => {
      vi.useFakeTimers();
      const context = setup({ restartMs: 100 });
      await started(context);
      const server = context.servers[0]!;
      const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      expect(server.connected).toBe(true);
      if (failure === "send") {
        vi.spyOn(server, "send").mockImplementation(() => {
          throw error;
        });
        await expect(context.supervisor.check()).resolves.toBeUndefined();
        expect(context.logs).toContain("Server IPC error: write EPIPE");
      } else {
        expect(() => server.emit("error", error)).not.toThrow();
        expect(
          context.logs.filter((line) => line === "Server IPC error: write EPIPE"),
        ).toHaveLength(1);
      }
      server.emit("exit", 3, null);
      await vi.advanceTimersByTimeAsync(100);
      expect(context.servers.map((child) => NodePath.basename(child.releaseDir))).toEqual([A, A]);
      expect(context.logs).toContain("Server exited (exit code 3); restarting (1/5).");
      const errorLogs = context.logs.filter((line) => line.startsWith("Server IPC error:"));
      server.emit("error", error);
      expect(context.logs.filter((line) => line.startsWith("Server IPC error:"))).toEqual(
        errorLogs,
      );
    },
  );

  it("defers a restart until an overlapping swap refuses preparation", async () => {
    vi.useFakeTimers();
    const context = setup({ restartMs: 10, prepareMs: 100, prepareReply: "none" });
    await started(context);
    context.servers[0]!.emit("exit", 3, null);
    const updating = context.supervisor.update();
    await vi.advanceTimersByTimeAsync(10);
    expect(context.servers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await updating;
    expect(context.servers.map((server) => NodePath.basename(server.releaseDir))).toEqual([A, A]);
    expect(context.logs.filter((line) => line.includes("; restarting"))).toHaveLength(1);
  });

  it.each(["update", "rollback"] as const)(
    "recovers during release building and leaves exactly one server after %s",
    async (outcome) => {
      vi.useFakeTimers();
      const building = Promise.withResolvers<void>();
      const built = Promise.withResolvers<void>();
      const context = setup({
        restartMs: 10,
        beforeBuild: () => {
          building.resolve();
          return built.promise;
        },
        startsFrom: (dir) => outcome !== "rollback" || !dir.endsWith(B),
      });
      NodeFS.mkdirSync(NodePath.join(context.releases, A), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(context.releases, A, ".t3-release-ready"), A);
      await started(context);
      const updating = context.supervisor.update();
      await building.promise;
      context.servers[0]!.emit("exit", 3, null);
      await vi.advanceTimersByTimeAsync(10);
      built.resolve();
      await vi.advanceTimersByTimeAsync(outcome === "rollback" ? 200 : 0);
      await updating;
      expect(context.servers.map((server) => NodePath.basename(server.releaseDir))).toEqual(
        outcome === "update" ? [A, A, B] : [A, A, B, A],
      );
      expect(context.logs.filter((line) => line.includes("; restarting"))).toHaveLength(1);
      expect(context.supervisor.snapshot().lastOutcome?.status).toBe(
        outcome === "update" ? "updated" : "rolled-back",
      );
    },
  );
});

async function withDeadline<T>(promise: Promise<T>, ms: number, milestone: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${milestone}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A child's close event can precede the OS reaping another process it killed. */
async function waitForReaped(pid: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Process ${pid} was not reaped within 10s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function realSupervisor(mode: "crash" | "stay") {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkout-supervisor-"));
  directories.push(root);
  const source = NodePath.join(root, "source");
  const baseDir = NodePath.join(root, "data");
  const releases = NodePath.join(root, "releases");
  NodeFS.mkdirSync(source);
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git(
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "A",
  );
  const commit = git("rev-parse", "HEAD");
  const key = NodeCrypto.createHash("sha256").update(baseDir).digest("hex").slice(0, 12);
  const release = NodePath.join(releases, key, commit);
  NodeFS.mkdirSync(NodePath.join(release, "apps/server/src"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(release, ".t3-release-ready"), commit);
  NodeFS.writeFileSync(
    NodePath.join(release, "apps/server/src/bin.ts"),
    `
console.log('stub ' + process.pid);
if (process.argv.at(-1) === 'crash') process.exit(3);
else setInterval(() => {}, 1000);
`,
  );
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.resolve("apps/server/scripts/checkout-supervisor.ts"),
      "--source",
      source,
      "--releases",
      releases,
      "--",
      "serve",
      "--base-dir",
      baseDir,
      "--stub-mode",
      mode,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const firstStub = Promise.withResolvers<void>();
  const collect = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (/^stub \d+$/m.test(output)) firstStub.resolve();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const pids = () => [
    child.pid!,
    ...Array.from(output.matchAll(/^stub (\d+)$/gm), (match) => Number(match[1])),
  ];
  return { child, closed, firstStub: firstStub.promise, output: () => output, pids };
}

async function cleanRealSupervisor(context: ReturnType<typeof realSupervisor>) {
  // All PIDs came from our spawn or the fixture's anchored stdout lines.
  for (const pid of context.pids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await context.closed;
  await Promise.all(context.pids().map(waitForReaped));
}

describe("CheckoutSupervisor real processes", () => {
  it("restarts crashes to the bound and reaps the supervisor and stub processes", async () => {
    const context = realSupervisor("crash");
    try {
      expect(await withDeadline(context.closed, 90_000, "crash exhaustion")).toBe(3);
      await Promise.all(context.pids().map(waitForReaped));
      expect(context.pids()).toHaveLength(2 + RESTART_LIMIT);
      const lines = context.output().split("\n");
      const restarts = lines.filter((line) => line.includes("; restarting"));
      expect(restarts).toHaveLength(RESTART_LIMIT);
      expect(restarts.every((line) => line.includes("exit code 3"))).toBe(true);
      expect(lines.filter((line) => line.includes("giving up"))).toHaveLength(1);
    } finally {
      await cleanRealSupervisor(context);
    }
  }, 120_000);

  it("forwards SIGTERM without restarting and waits for both processes to be reaped", async () => {
    const context = realSupervisor("stay");
    try {
      await withDeadline(context.firstStub, 10_000, "stub startup");
      context.child.kill("SIGTERM");
      expect(await withDeadline(context.closed, 10_000, "supervisor stop")).toBe(1);
      await Promise.all(context.pids().map(waitForReaped));
      expect(context.pids()).toHaveLength(2);
      expect(context.output()).not.toContain("; restarting");
      expect(context.output()).not.toContain("giving up");
    } finally {
      await cleanRealSupervisor(context);
    }
  }, 120_000);
});
