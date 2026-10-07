// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - drives the launcher with fake processes.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import type { SupervisorMessage } from "../src/checkoutUpdate/protocol.ts";
import { CheckoutSupervisor, type ExecResult, type ServerProcess } from "./checkout-supervisor.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

class FakeServer extends NodeEvents.EventEmitter implements ServerProcess {
  connected = true;
  readonly sent: SupervisorMessage[] = [];
  readonly signals: string[] = [];
  readonly releaseDir: string;
  constructor(releaseDir: string) {
    super();
    this.releaseDir = releaseDir;
  }
  send(message: SupervisorMessage) {
    this.sent.push(message);
    // A server prepares as soon as it is asked.
    if (message.type === "t3-checkout.prepare") {
      queueMicrotask(() => this.emit("message", { type: "t3-checkout.prepared", threads: 1 }));
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
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function setup(input: {
  readonly ahead?: boolean;
  readonly buildFails?: boolean;
  /** Whether a server started from this release reports ready. */
  readonly startsFrom?: (releaseDir: string) => boolean;
}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkout-supervisor-"));
  directories.push(root);
  const releases = NodePath.join(root, "releases");
  const baseDir = NodePath.join(root, "data");
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
    log: () => {},
    timeouts: { prepareMs: 1_000, stopMs: 1_000, readyMs: 200 },
    startServer: (releaseDir) => {
      const server = new FakeServer(releaseDir);
      servers.push(server);
      if (input.startsFrom?.(releaseDir) ?? true) queueMicrotask(() => server.ready());
      return server;
    },
  });
  const pointer = () =>
    JSON.parse(NodeFS.readFileSync(NodePath.join(baseDir, "checkout-release.json"), "utf8")).commit;
  return { supervisor, servers, commands, releases, pointer };
}

/** Starts the supervisor and waits for its first check to finish. */
async function started(context: ReturnType<typeof setup>) {
  void context.supervisor.run();
  for (let turn = 0; turn < 50 && context.supervisor.snapshot().checkedAt === null; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("CheckoutSupervisor", () => {
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
    expect(failing.supervisor.snapshot().phase).toBe("failed");
    expect(failing.supervisor.snapshot().message).toContain("vite: something broke");
  });

  it("never offers a commit that is not after the running one", async () => {
    const context = setup({ ahead: false });
    await started(context);
    expect(context.supervisor.snapshot().available).toBeNull();
  });
});
