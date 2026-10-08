#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off - a launcher outside the server's runtime.
/**
 * Runs a T3 server from a git checkout and replaces it with a newer commit when
 * a person asks from T3.
 *
 *   node apps/server/scripts/checkout-supervisor.ts --source <checkout>
 *     [--remote origin] [--branch master] [--releases <dir>]
 *     -- serve --host <host> --port <port> --base-dir <dir> [...]
 *
 * Each commit runs from a release of its own, a worktree of the checkout with
 * its dependencies installed and its web app built, so the running server is
 * never changed under it. An update builds the new release while the server
 * keeps serving, asks the server to mark its running turns to continue, stops
 * it, and starts the new release on the same port and data. If the new release
 * does not report ready, the previous one is started again.
 *
 * The release a data directory runs is recorded in it (`checkout-release.json`).
 * Ctrl-C stops the server and the supervisor.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CHECKOUT_SUPERVISOR_ENV,
  type CheckoutCommit,
  type CheckoutUpdatePhase,
  type CheckoutUpdateSnapshot,
  isServerMessage,
  type ServerMessage,
  type SupervisorMessage,
} from "../src/checkoutUpdate/protocol.ts";

const READY_MARKER = ".t3-release-ready";
const POINTER = "checkout-release.json";
const CHECK_EVERY_MS = 30 * 60 * 1000;

export interface ExecResult {
  readonly code: number;
  readonly output: string;
}

/** The part of a child process the supervisor uses. */
export interface ServerProcess {
  readonly pid?: number | undefined;
  readonly connected: boolean;
  send(message: SupervisorMessage): void;
  kill(signal?: NodeJS.Signals): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export interface SupervisorOptions {
  readonly source: string;
  readonly remote: string;
  readonly branch: string;
  /** Releases of this data directory. */
  readonly releases: string;
  /** The server's data directory. */
  readonly baseDir: string;
  readonly exec: (command: string, args: readonly string[], cwd: string) => Promise<ExecResult>;
  readonly startServer: (releaseDir: string) => ServerProcess;
  readonly log: (line: string) => void;
  readonly now?: () => Date;
  readonly timeouts?: {
    readonly prepareMs?: number;
    readonly stopMs?: number;
    readonly readyMs?: number;
  };
}

const short = (commit: string) => commit.slice(0, 7);
const lastLines = (text: string, count = 12) => text.trim().split("\n").slice(-count).join("\n");

class Waiter<T> {
  #resolve: ((value: T) => void) | null = null;
  wait(ms: number, onTimeout: T): Promise<T> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#resolve = null;
        resolve(onTimeout);
      }, ms);
      this.#resolve = (value) => {
        clearTimeout(timer);
        this.#resolve = null;
        resolve(value);
      };
    });
  }
  settle(value: T): void {
    this.#resolve?.(value);
  }
}

export class CheckoutSupervisor {
  readonly #options: SupervisorOptions;
  readonly #now: () => Date;
  #running: CheckoutCommit = { commit: "", subject: "" };
  #available: CheckoutUpdateSnapshot["available"] = null;
  #phase: CheckoutUpdatePhase = "idle";
  #message: string | null = null;
  #checkedAt: string | null = null;
  #lastOutcome: CheckoutUpdateSnapshot["lastOutcome"] = null;
  #server: ServerProcess | null = null;
  #swapping = false;
  #busy = false;
  #stopping = false;
  readonly #ready = new Waiter<boolean>();
  readonly #prepared = new Waiter<boolean>();
  readonly #exited = new Waiter<boolean>();
  #finish: (code: number) => void = () => {};
  readonly finished: Promise<number>;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.finished = new Promise((resolve) => {
      this.#finish = resolve;
    });
  }

  snapshot(): CheckoutUpdateSnapshot {
    return {
      running: this.#running,
      available: this.#available,
      phase: this.#phase,
      message: this.#message,
      checkedAt: this.#checkedAt,
      lastOutcome: this.#lastOutcome,
    };
  }

  #git(args: readonly string[]) {
    return this.#options.exec("git", ["-C", this.#options.source, ...args], this.#options.source);
  }

  async #describe(commit: string): Promise<CheckoutCommit> {
    const result = await this.#git(["log", "-1", "--format=%s", commit]);
    return { commit, subject: result.code === 0 ? result.output.trim() : "" };
  }

  #set(phase: CheckoutUpdatePhase, message: string | null) {
    this.#phase = phase;
    this.#message = message;
    if (message) this.#options.log(message);
    this.#broadcast();
  }

  #broadcast() {
    const server = this.#server;
    if (server?.connected) server.send({ type: "t3-checkout.state", state: this.snapshot() });
  }

  #releaseDir(commit: string) {
    return NodePath.join(this.#options.releases, commit);
  }

  #readPointer(): string | null {
    try {
      const value = JSON.parse(
        NodeFS.readFileSync(NodePath.join(this.#options.baseDir, POINTER), "utf8"),
      ) as { commit?: unknown };
      return typeof value.commit === "string" && /^[0-9a-f]{40}$/.test(value.commit)
        ? value.commit
        : null;
    } catch {
      return null;
    }
  }

  #writePointer(commit: string) {
    const file = NodePath.join(this.#options.baseDir, POINTER);
    NodeFS.mkdirSync(this.#options.baseDir, { recursive: true });
    NodeFS.writeFileSync(`${file}.tmp`, `${JSON.stringify({ commit })}\n`);
    NodeFS.renameSync(`${file}.tmp`, file);
  }

  /** A built release of the commit, made when there is none. */
  async #ensureRelease(commit: string): Promise<string> {
    const dir = this.#releaseDir(commit);
    if (NodeFS.existsSync(NodePath.join(dir, READY_MARKER))) return dir;
    if (NodeFS.existsSync(dir)) {
      await this.#git(["worktree", "remove", "--force", dir]);
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
    await this.#git(["worktree", "prune"]);
    NodeFS.mkdirSync(this.#options.releases, { recursive: true });
    const steps: [CheckoutUpdatePhase, string, () => Promise<ExecResult>][] = [
      [
        "installing",
        `Checking out ${short(commit)}.`,
        () => this.#git(["worktree", "add", "--detach", dir, commit]),
      ],
      [
        "installing",
        "Installing dependencies.",
        () => this.#options.exec("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], dir),
      ],
      [
        "building",
        "Building the web app.",
        () => this.#options.exec("pnpm", ["--dir", "apps/web", "run", "build"], dir),
      ],
    ];
    for (const [phase, message, run] of steps) {
      this.#set(phase, message);
      const result = await run();
      if (result.code !== 0)
        throw new Error(`${message.replace(/\.$/, "")} failed:\n${lastLines(result.output)}`);
    }
    NodeFS.writeFileSync(NodePath.join(dir, READY_MARKER), `${commit}\n`);
    return dir;
  }

  /** Keeps the running release and the one before it. */
  #prune(keep: readonly string[]) {
    let entries: string[] = [];
    try {
      entries = NodeFS.readdirSync(this.#options.releases);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!/^[0-9a-f]{40}$/.test(entry) || keep.includes(entry)) continue;
      void this.#git(["worktree", "remove", "--force", this.#releaseDir(entry)]).then(() =>
        NodeFS.rmSync(this.#releaseDir(entry), { recursive: true, force: true }),
      );
    }
  }

  #start(commit: string) {
    const server = this.#options.startServer(this.#releaseDir(commit));
    this.#server = server;
    server.on("message", (message) => {
      if (server === this.#server && isServerMessage(message)) void this.#onMessage(message);
    });
    server.on("exit", (code, signal) => {
      if (server !== this.#server) return;
      this.#ready.settle(false);
      this.#exited.settle(true);
      if (this.#swapping) return;
      // Outside an update the server's end is the supervisor's.
      this.#finish(code ?? (signal ? 1 : 0));
    });
    return server;
  }

  async #onMessage(message: ServerMessage) {
    if (message.type === "t3-checkout.ready") {
      this.#ready.settle(true);
      this.#broadcast();
    } else if (message.type === "t3-checkout.prepared") {
      this.#prepared.settle(true);
    } else if (message.type === "t3-checkout.preparation-failed") {
      this.#prepared.settle(false);
    } else if (message.type === "t3-checkout.check") {
      await this.check();
    } else if (message.type === "t3-checkout.update") {
      await this.update();
    }
  }

  async #stopServer() {
    const server = this.#server;
    if (!server) return;
    const exited = this.#exited.wait(this.#options.timeouts?.stopMs ?? 20_000, false);
    server.kill("SIGTERM");
    if (!(await exited)) {
      const killed = this.#exited.wait(5_000, false);
      server.kill("SIGKILL");
      await killed;
    }
  }

  async #startAndWait(commit: string): Promise<boolean> {
    const ready = this.#ready.wait(this.#options.timeouts?.readyMs ?? 180_000, false);
    this.#start(commit);
    return ready;
  }

  /** Builds the running release if needed, starts it, and checks for newer commits. */
  async run(): Promise<number> {
    const head = await this.#git(["rev-parse", "HEAD"]);
    const commit = this.#readPointer() ?? head.output.trim();
    if (!/^[0-9a-f]{40}$/.test(commit))
      throw new Error(`Could not read the checkout's commit:\n${head.output}`);
    this.#running = await this.#describe(commit);
    await this.#ensureRelease(commit);
    this.#writePointer(commit);
    this.#set("idle", null);
    this.#start(commit);
    const timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    timer.unref();
    void this.check();
    const code = await this.finished;
    clearInterval(timer);
    return code;
  }

  /** Ctrl-C: the server stops, then the supervisor. */
  async stop(signal: NodeJS.Signals) {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#swapping = false;
    const server = this.#server;
    if (!server) return this.#finish(130);
    server.kill(signal);
  }

  async check(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      this.#set("checking", null);
      const { remote, branch } = this.#options;
      const fetched = await this.#git(["fetch", "--quiet", remote, branch]);
      const target = await this.#git(["rev-parse", `refs/remotes/${remote}/${branch}`]);
      this.#checkedAt = this.#now().toISOString();
      if (fetched.code !== 0 || target.code !== 0) {
        this.#set(
          "idle",
          `Could not check ${remote}/${branch}: ${lastLines(fetched.output || target.output, 2)}`,
        );
        return;
      }
      const commit = target.output.trim();
      // Only a commit after the running one is offered: never a step back.
      const ahead = await this.#git(["merge-base", "--is-ancestor", this.#running.commit, commit]);
      if (commit === this.#running.commit || ahead.code !== 0) {
        this.#available = null;
      } else {
        const behind = await this.#git([
          "rev-list",
          "--count",
          `${this.#running.commit}..${commit}`,
        ]);
        this.#available = {
          ...(await this.#describe(commit)),
          behind: behind.code === 0 ? Number(behind.output.trim()) || 0 : 0,
        };
      }
      this.#set("idle", null);
    } finally {
      this.#busy = false;
    }
  }

  async update(): Promise<void> {
    if (this.#busy || this.#swapping) return;
    if (!this.#available) await this.check();
    const target = this.#available;
    if (!target || this.#busy) return;
    this.#busy = true;
    const previous = this.#running;
    try {
      await this.#ensureRelease(target.commit);
    } catch (error) {
      this.#busy = false;
      this.#set("failed", error instanceof Error ? error.message : String(error));
      return;
    }
    this.#swapping = true;
    try {
      this.#set("restarting", `Restarting into ${short(target.commit)}.`);
      const prepared = this.#prepared.wait(this.#options.timeouts?.prepareMs ?? 15_000, false);
      this.#server?.send({ type: "t3-checkout.prepare" });
      if (!(await prepared)) {
        this.#set(
          "failed",
          "The running server did not confirm restart preparation. Retry the update after checking it; no server was replaced.",
        );
        return;
      }
      await this.#stopServer();
      if (this.#stopping) return this.#finish(130);
      if (await this.#startAndWait(target.commit)) {
        this.#writePointer(target.commit);
        this.#running = { commit: target.commit, subject: target.subject };
        this.#available = null;
        this.#lastOutcome = {
          from: previous.commit,
          to: target.commit,
          status: "updated",
          reason: null,
        };
        this.#prune([target.commit, previous.commit]);
        this.#options.log(`Running ${short(target.commit)}.`);
        this.#set("idle", null);
        return;
      }
      const reason = `${short(target.commit)} did not start.`;
      await this.#stopServer();
      if (this.#stopping) return this.#finish(130);
      this.#lastOutcome = {
        from: previous.commit,
        to: target.commit,
        status: "rolled-back",
        reason,
      };
      this.#phase = "failed";
      this.#message = `${reason} T3 went back to ${short(previous.commit)}.`;
      this.#options.log(this.#message);
      if (!(await this.#startAndWait(previous.commit))) {
        this.#options.log(`${short(previous.commit)} did not start again either.`);
        await this.#stopServer();
        this.#finish(1);
      }
    } finally {
      this.#swapping = false;
      this.#busy = false;
    }
  }
}

function execCommand(command: string, args: readonly string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-64_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

function parseArguments(argv: readonly string[]) {
  const split = argv.indexOf("--");
  if (split < 0) throw new Error("Pass the server's arguments after --.");
  const own = argv.slice(0, split);
  const serve = argv.slice(split + 1);
  const value = (name: string) => {
    const index = own.indexOf(name);
    return index >= 0 ? own[index + 1] : undefined;
  };
  const baseDirIndex = serve.indexOf("--base-dir");
  const baseDir = baseDirIndex >= 0 ? serve[baseDirIndex + 1] : undefined;
  const source = value("--source");
  if (!source || !baseDir) throw new Error("--source and the server's --base-dir are required.");
  const resolvedBaseDir = NodePath.resolve(baseDir);
  // One folder of releases per data directory, so profiles never prune each other's.
  const key = NodeCrypto.createHash("sha256").update(resolvedBaseDir).digest("hex").slice(0, 12);
  return {
    source: NodePath.resolve(source),
    remote: value("--remote") ?? "origin",
    branch: value("--branch") ?? "master",
    releases: NodePath.join(
      NodePath.resolve(value("--releases") ?? NodePath.join(NodeOS.homedir(), ".t3", "releases")),
      key,
    ),
    baseDir: resolvedBaseDir,
    serve,
  };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const supervisor = new CheckoutSupervisor({
    ...parsed,
    exec: execCommand,
    log: (line) => console.log(`[t3 update] ${line}`),
    startServer: (releaseDir) =>
      NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(releaseDir, "apps/server/src/bin.ts"), ...parsed.serve],
        {
          cwd: parsed.source,
          env: { ...process.env, [CHECKOUT_SUPERVISOR_ENV]: "1" },
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        },
      ) as NodeChildProcess.ChildProcess & ServerProcess,
  });
  process.on("SIGINT", () => void supervisor.stop("SIGINT"));
  process.on("SIGTERM", () => void supervisor.stop("SIGTERM"));
  process.exitCode = await supervisor.run();
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
