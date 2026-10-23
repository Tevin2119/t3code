import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const DRAFT_TEAMS_KEY = "t3code:delivery-draft-teams:v1";
const ORCHESTRATOR_KEY = "t3code:delivery-orchestrator-drafts:v1";
const BOARD_KEY = "t3code:delivery-board:v1";

function createLocalStorageStub(seed: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(seed));
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

let storage: Storage;

/** The stores as a page that has just loaded has them, over what is kept in storage. */
async function load() {
  vi.resetModules();
  return import("./delivery");
}

const kept = (key: string) => JSON.parse(storage.getItem(key) ?? "null");

beforeEach(() => {
  storage = createLocalStorageStub();
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the team of a draft thread", () => {
  it("is No team for a new thread, and development only for Orchestrator mode", async () => {
    const state = await load();
    expect(state.DEFAULT_DRAFT_TEAM_CHOICE).toEqual({ team: null, role: null });
    expect(state.readDraftTeamChoice("t1", "env-a")).toEqual({ team: null, role: null });
    expect(state.hasDraftTeamChoice("t1")).toBe(false);

    // The same environment, with nothing remembered: Orchestrator mode needs a team.
    state.useOrchestratorDraftStore.getState().enter("t1", "env-a");
    expect(state.useOrchestratorDraftStore.getState().drafts.t1?.team).toBe("development");
  });

  it("remembers the last team chosen in the picker, for that environment only", async () => {
    const state = await load();
    const drafts = state.useDeliveryDraftStore.getState();
    drafts.chooseTeam("t1", "env-a", { team: "rnd", role: "scout" });

    expect(state.readDraftTeamChoice("t1", "env-a")).toEqual({ team: "rnd", role: "scout" });
    expect(state.hasDraftTeamChoice("t1")).toBe(true);
    // The next new thread starts from the team, as a choice it did not make, with no role.
    expect(state.readDraftTeamChoice("t2", "env-a")).toEqual({ team: "rnd", role: null });
    expect(state.hasDraftTeamChoice("t2")).toBe(false);
    // Another environment has its own, or none.
    expect(state.readDraftTeamChoice("t3", "env-b")).toEqual({ team: null, role: null });
    drafts.chooseTeam("t3", "env-b", { team: "development", role: null });
    expect(state.readDraftTeamChoice("t4", "env-b").team).toBe("development");
    expect(state.readDraftTeamChoice("t2", "env-a").team).toBe("rnd");

    // Choosing No team displaces the team.
    drafts.chooseTeam("t2", "env-a", { team: null, role: null });
    expect(state.readDraftTeamChoice("t5", "env-a")).toEqual({ team: null, role: null });
    expect(state.readRememberedTeam("env-a")).toBeNull();
  });

  it("puts a thread's own choice before what is remembered", async () => {
    const state = await load();
    const drafts = state.useDeliveryDraftStore.getState();
    drafts.chooseTeam("t1", "env-a", { team: "rnd", role: null });
    drafts.chooseTeam("t2", "env-a", { team: "development", role: null });
    expect(state.readDraftTeamChoice("t1", "env-a").team).toBe("rnd");
    expect(state.readRememberedTeam("env-a")).toBe("development");
  });

  it("neither reads nor writes what is remembered without an environment", async () => {
    const state = await load();
    const drafts = state.useDeliveryDraftStore.getState();
    drafts.chooseTeam("t1", "env-a", { team: "rnd", role: null });
    drafts.chooseTeam("t2", null, { team: "development", role: null });
    drafts.chooseTeam("t3", "", { team: "development", role: null });
    drafts.rememberTeam(null, "development");
    drafts.rememberTeam("", "development");

    expect(state.useDeliveryDraftStore.getState().remembered).toEqual({ "env-a": "rnd" });
    expect(state.readDraftTeamChoice("t2", null).team).toBe("development");
    expect(state.readDraftTeamChoice("t9", null)).toEqual({ team: null, role: null });
    expect(state.readDraftTeamChoice("t9", "")).toEqual({ team: null, role: null });
    expect(state.readRememberedTeam(undefined)).toBeNull();
  });

  it("keeps what is remembered across a reload, as a team name and nothing more", async () => {
    const before = await load();
    before.useDeliveryDraftStore
      .getState()
      .chooseTeam("t1", "env-a", { team: "rnd", role: "scout" });
    before.useDeliveryDraftStore.getState().chooseTeam("t2", "env-b", { team: null, role: null });

    expect(kept(DRAFT_TEAMS_KEY).version).toBe(0);
    expect(kept(DRAFT_TEAMS_KEY).state.remembered).toEqual({ "env-a": "rnd", "env-b": null });

    const after = await load();
    expect(after.useDeliveryDraftStore).not.toBe(before.useDeliveryDraftStore);
    expect(after.readDraftTeamChoice("t3", "env-a")).toEqual({ team: "rnd", role: null });
    expect(after.readDraftTeamChoice("t4", "env-b")).toEqual({ team: null, role: null });
  });

  it("reads what was kept before teams were remembered, and loses none of it", async () => {
    storage.setItem(
      DRAFT_TEAMS_KEY,
      JSON.stringify({
        state: { choices: { t1: { team: "rnd", role: null } }, inherited: { t2: "sent" } },
        version: 0,
      }),
    );
    const state = await load();
    const drafts = state.useDeliveryDraftStore.getState();
    expect(drafts.choices).toEqual({ t1: { team: "rnd", role: null } });
    expect(drafts.inherited).toEqual({ t2: state.SEAT_TAKEOVER_OVER });
    expect(drafts.remembered).toEqual({});
    expect(state.readDraftTeamChoice("t3", "env-a")).toEqual({ team: null, role: null });
  });

  it("tells a choice in the picker from the way out of a failed team setup", async () => {
    const state = await load();
    const drafts = state.useDeliveryDraftStore.getState();
    drafts.chooseTeam("t1", "env-a", { team: "rnd", role: null });

    // The footer's "start without a team": No team for the thread, and the team stays remembered.
    drafts.setChoice("t1", { team: null, role: null });
    expect(state.readDraftTeamChoice("t1", "env-a")).toEqual({ team: null, role: null });
    expect(state.hasDraftTeamChoice("t1")).toBe(true);
    expect(state.readRememberedTeam("env-a")).toBe("rnd");

    // No team chosen in the picker is remembered.
    drafts.chooseTeam("t1", "env-a", { team: null, role: null });
    expect(state.readRememberedTeam("env-a")).toBeNull();
  });

  it("clears a sent thread's choice, keeps what is remembered and ends the seat takeover", async () => {
    const state = await load();
    const drafts = state.useDeliveryDraftStore.getState();
    drafts.chooseTeam("t1", "env-a", { team: "rnd", role: "scout" });
    drafts.markInherited("t1", "rnd|scout|kimi|k2||full");
    drafts.clearChoice("t1");

    expect(state.hasDraftTeamChoice("t1")).toBe(false);
    expect(state.readDraftTeamChoice("t1", "env-a")).toEqual({ team: "rnd", role: null });
    expect(state.readRememberedTeam("env-a")).toBe("rnd");
    expect(state.useDeliveryDraftStore.getState().inherited.t1).toBe(state.SEAT_TAKEOVER_OVER);
    // The mark of a sent thread is not replaced by a seat's.
    drafts.markInherited("t1", "rnd|scout|kimi|k2||full");
    expect(state.useDeliveryDraftStore.getState().inherited.t1).toBe(state.SEAT_TAKEOVER_OVER);

    // Remembering a team leaves the marks as they are.
    drafts.markInherited("t2", "rnd|scout|kimi|k2||full");
    drafts.chooseTeam("t3", "env-a", { team: "development", role: null });
    drafts.rememberTeam("env-a", "rnd");
    expect(state.useDeliveryDraftStore.getState().inherited).toEqual({
      t1: state.SEAT_TAKEOVER_OVER,
      t2: "rnd|scout|kimi|k2||full",
    });
  });
});

describe("the team of an Orchestrator draft", () => {
  it.each([null, "old"])(
    "settles offered teams without remembering them (remembered %s)",
    async (remembered) => {
      const state = await load();
      const memory = state.useDeliveryDraftStore.getState();
      if (remembered) memory.rememberTeam("env-a", remembered);
      memory.rememberTeam("env-b", "other");
      const before = state.useDeliveryDraftStore.getState().remembered;
      const store = state.useOrchestratorDraftStore.getState();
      for (const [id, teams, expected] of [
        ["first", ["rnd", "alpha"], "rnd"],
        ["default", ["rnd", "development"], "development"],
      ] as const) {
        store.enter(id, "env-a");
        store.update(id, { workflow: "plan" });
        store.setSeat(id, "developer", { model: "m" });
        store.reconcileTeam(id, teams);
        const settled = state.useOrchestratorDraftStore.getState().drafts[id];
        expect(settled).toEqual({
          team: expected,
          workflow: !remembered && expected === "development" ? "plan" : "",
          seats: !remembered && expected === "development" ? { developer: { model: "m" } } : {},
          engineThread: null,
          savedText: null,
        });
        expect(kept(ORCHESTRATOR_KEY)).toEqual({
          state: { drafts: state.useOrchestratorDraftStore.getState().drafts },
          version: 0,
        });
        store.reconcileTeam(id, ["different"]);
        expect(state.useOrchestratorDraftStore.getState().drafts[id]).toBe(settled);
        expect(state.useDeliveryDraftStore.getState().remembered).toEqual(before);
      }
    },
  );

  it.each([null, "rnd"])(
    "goes on waiting through an empty list, changing nothing (remembered %s)",
    async (remembered) => {
      const state = await load();
      if (remembered) state.useDeliveryDraftStore.getState().rememberTeam("env-a", remembered);
      const memory = state.useDeliveryDraftStore.getState().remembered;
      const store = state.useOrchestratorDraftStore.getState();
      store.enter("t1", "env-a");
      store.update("t1", { workflow: "plan" });
      store.setSeat("t1", "developer", { model: "m" });
      const entered = state.useOrchestratorDraftStore.getState().drafts.t1;
      store.reconcileTeam("t1", []);
      store.reconcileTeam("t1", []);
      const waiting = state.useOrchestratorDraftStore.getState().drafts.t1;
      expect(waiting).toBe(entered);
      expect(waiting).toEqual({
        team: remembered ?? "development",
        workflow: "plan",
        seats: { developer: { model: "m" } },
        engineThread: null,
        savedText: null,
        awaitingTeams: true,
      });
      expect(kept(ORCHESTRATOR_KEY).state.drafts.t1).toEqual(waiting);
      expect(state.useDeliveryDraftStore.getState().remembered).toEqual(memory);
      // The first list that offers a team is the one the draft is held against.
      store.reconcileTeam("t1", ["alpha"]);
      expect(state.useOrchestratorDraftStore.getState().drafts.t1).toEqual({
        team: "alpha",
        workflow: "",
        seats: {},
        engineThread: null,
        savedText: null,
      });
      expect(state.useDeliveryDraftStore.getState().remembered).toEqual(memory);
    },
  );

  it.each([
    [null, ["rnd", "alpha"], "rnd"],
    [null, ["rnd", "development"], "development"],
    ["gone", ["rnd", "development"], "development"],
    ["gone", ["rnd", "alpha"], "rnd"],
    ["alpha", ["rnd", "development", "alpha"], "alpha"],
  ] as const)(
    "settles on the first list that offers a team after an empty one (remembered %s, %j)",
    async (remembered, teams, expected) => {
      const state = await load();
      if (remembered) state.useDeliveryDraftStore.getState().rememberTeam("env-a", remembered);
      const memory = state.useDeliveryDraftStore.getState().remembered;
      const store = state.useOrchestratorDraftStore.getState();
      store.enter("t1", "env-a");
      store.update("t1", { workflow: "plan" });
      store.setSeat("t1", "developer", { model: "m" });
      store.reconcileTeam("t1", []);
      store.reconcileTeam("t1", teams);
      // Flow and seats stand while the team does, and go when it gives way.
      const retained = expected === (remembered ?? "development");
      expect(state.useOrchestratorDraftStore.getState().drafts.t1).toEqual({
        team: expected,
        workflow: retained ? "plan" : "",
        seats: retained ? { developer: { model: "m" } } : {},
        engineThread: null,
        savedText: null,
      });
      expect(state.useDeliveryDraftStore.getState().remembered).toEqual(memory);
    },
  );

  it("settles on rnd after an empty list, and not again when the list changes", async () => {
    const state = await load();
    const store = state.useOrchestratorDraftStore.getState();
    store.enter("t1", "env-a");
    store.reconcileTeam("t1", []);
    store.reconcileTeam("t1", ["rnd"]);
    const settled = state.useOrchestratorDraftStore.getState().drafts.t1;
    expect(settled?.team).toBe("rnd");
    expect(settled).not.toHaveProperty("awaitingTeams");

    store.reconcileTeam("t1", ["alpha"]);
    expect(state.useOrchestratorDraftStore.getState().drafts.t1).toBe(settled);
  });

  it("never replaces a team a person chose while the list was empty", async () => {
    const state = await load();
    const store = state.useOrchestratorDraftStore.getState();
    store.enter("t1", "env-a");
    store.reconcileTeam("t1", []);
    store.chooseTeam("t1", "env-a", "picked");
    const chosen = state.useOrchestratorDraftStore.getState().drafts.t1;
    store.reconcileTeam("t1", ["rnd", "development"]);
    expect(state.useOrchestratorDraftStore.getState().drafts.t1).toBe(chosen);
    expect(chosen?.team).toBe("picked");
    expect(state.readRememberedTeam("env-a")).toBe("picked");
  });

  it("settles a saved draft on an empty list, keeping its team through later lists", async () => {
    const state = await load();
    const store = state.useOrchestratorDraftStore.getState();
    store.enter("t1", "env-a");
    store.update("t1", { engineThread: "task-1", savedText: "text", workflow: "plan" });
    store.setSeat("t1", "developer", { model: "m" });
    store.reconcileTeam("t1", []);
    const settled = state.useOrchestratorDraftStore.getState().drafts.t1;
    expect(settled).toEqual({
      team: "development",
      workflow: "plan",
      seats: { developer: { model: "m" } },
      engineThread: "task-1",
      savedText: "text",
    });
    store.reconcileTeam("t1", ["rnd", "alpha"]);
    expect(state.useOrchestratorDraftStore.getState().drafts.t1).toBe(settled);
  });

  it("starts from the remembered team, else from development", async () => {
    const state = await load();
    const drafts = state.useDeliveryDraftStore.getState();
    const orchestrator = state.useOrchestratorDraftStore.getState();
    drafts.rememberTeam("env-a", "rnd");
    drafts.rememberTeam("env-b", null);

    orchestrator.enter("t1", "env-a");
    orchestrator.enter("t2", "env-b");
    orchestrator.enter("t3", "env-c");
    orchestrator.enter("t4", null);
    const made = state.useOrchestratorDraftStore.getState().drafts;
    expect(made.t1).toMatchObject({ team: "rnd", awaitingTeams: true });
    expect(made.t2).toMatchObject({ team: "development", awaitingTeams: true });
    expect(made.t3?.team).toBe("development");
    expect(made.t4?.team).toBe("development");
    // Entering and falling back are not a person's choice.
    expect(state.useDeliveryDraftStore.getState().remembered).toEqual({
      "env-a": "rnd",
      "env-b": null,
    });

    // Entering again leaves the draft as it is.
    drafts.rememberTeam("env-a", "development");
    orchestrator.enter("t1", "env-a");
    expect(state.useOrchestratorDraftStore.getState().drafts.t1?.team).toBe("rnd");
  });

  it("gives a team that is gone up for development, once, when the teams are read", async () => {
    const state = await load();
    state.useDeliveryDraftStore.getState().rememberTeam("env-a", "old");
    const orchestrator = state.useOrchestratorDraftStore.getState();
    orchestrator.enter("t1", "env-a");
    orchestrator.setSeat("t1", "developer", { model: "m" });

    orchestrator.reconcileTeam("t1", ["development", "rnd"]);
    const settled = state.useOrchestratorDraftStore.getState().drafts.t1;
    expect(settled).toEqual({
      team: "development",
      workflow: "",
      seats: {},
      engineThread: null,
      savedText: null,
    });
    // The correction is not a person's choice.
    expect(state.readRememberedTeam("env-a")).toBe("old");

    // A later reading does not correct again, whatever it lists.
    orchestrator.reconcileTeam("t1", ["rnd"]);
    expect(state.useOrchestratorDraftStore.getState().drafts.t1).toBe(settled);
  });

  it("keeps a remembered team that is listed, and goes on waiting through an empty list", async () => {
    const state = await load();
    state.useDeliveryDraftStore.getState().rememberTeam("env-a", "rnd");
    const orchestrator = state.useOrchestratorDraftStore.getState();
    orchestrator.enter("t1", "env-a");
    orchestrator.reconcileTeam("t1", ["development", "rnd"]);
    expect(state.useOrchestratorDraftStore.getState().drafts.t1).toMatchObject({ team: "rnd" });
    expect(state.useOrchestratorDraftStore.getState().drafts.t1).not.toHaveProperty(
      "awaitingTeams",
    );

    orchestrator.enter("t2", "env-a");
    orchestrator.reconcileTeam("t2", []);
    expect(state.useOrchestratorDraftStore.getState().drafts.t2).toMatchObject({
      team: "rnd",
      awaitingTeams: true,
    });
  });

  it("never replaces a team a person chose before the teams were read", async () => {
    const state = await load();
    state.useDeliveryDraftStore.getState().rememberTeam("env-a", "old");
    const orchestrator = state.useOrchestratorDraftStore.getState();
    orchestrator.enter("t1", "env-a");
    // The same name as the draft started from: still a choice, which stands.
    orchestrator.chooseTeam("t1", "env-a", "old");
    orchestrator.reconcileTeam("t1", ["development"]);
    expect(state.useOrchestratorDraftStore.getState().drafts.t1?.team).toBe("old");

    orchestrator.enter("t2", "env-a");
    orchestrator.setSeat("t2", "developer", { model: "m" });
    orchestrator.chooseTeam("t2", "env-a", "rnd");
    orchestrator.reconcileTeam("t2", ["development"]);
    expect(state.useOrchestratorDraftStore.getState().drafts.t2).toMatchObject({
      team: "rnd",
      // Settings made for one team's seats mean nothing for another's.
      seats: {},
    });
    expect(state.readRememberedTeam("env-a")).toBe("rnd");
  });

  it("remembers a team chosen in Orchestrator mode, and nothing else written to a draft", async () => {
    const state = await load();
    const orchestrator = state.useOrchestratorDraftStore.getState();
    orchestrator.enter("t1", "env-a");
    orchestrator.update("t1", { workflow: "plan" });
    orchestrator.update("t1", { engineThread: "task-1", savedText: "text" });
    expect(state.useDeliveryDraftStore.getState().remembered).toEqual({});
    // Writing the flow or a saving back does not settle the team either.
    expect(state.useOrchestratorDraftStore.getState().drafts.t1?.awaitingTeams).toBe(true);

    orchestrator.chooseTeam("t1", "env-a", "rnd");
    expect(state.readRememberedTeam("env-a")).toBe("rnd");
    // A new plain thread on the environment starts from it too.
    expect(state.readDraftTeamChoice("t2", "env-a")).toEqual({ team: "rnd", role: null });
    orchestrator.chooseTeam("t1", null, "development");
    expect(state.useDeliveryDraftStore.getState().remembered).toEqual({ "env-a": "rnd" });
  });

  it("leaves a saved draft's team, and a draft kept before this, as they are", async () => {
    storage.setItem(
      ORCHESTRATOR_KEY,
      JSON.stringify({
        state: {
          drafts: {
            legacy: { team: "old", workflow: "", seats: {}, engineThread: null, savedText: null },
          },
        },
        version: 0,
      }),
    );
    const state = await load();
    const orchestrator = state.useOrchestratorDraftStore.getState();
    const legacy = orchestrator.drafts.legacy;
    orchestrator.reconcileTeam("legacy", ["rnd", "alpha"]);
    expect(state.useOrchestratorDraftStore.getState().drafts.legacy).toBe(legacy);

    state.useDeliveryDraftStore.getState().rememberTeam("env-a", "old");
    orchestrator.enter("t1", "env-a");
    orchestrator.update("t1", { engineThread: "task-1", savedText: "text" });
    orchestrator.reconcileTeam("t1", ["rnd", "alpha"]);
    expect(state.useOrchestratorDraftStore.getState().drafts.t1).toMatchObject({
      team: "old",
      engineThread: "task-1",
    });
  });

  it("still waits for the teams after a reload", async () => {
    const before = await load();
    before.useDeliveryDraftStore.getState().rememberTeam("env-a", "old");
    before.useOrchestratorDraftStore.getState().enter("t1", "env-a");
    expect(kept(ORCHESTRATOR_KEY).state.drafts.t1.awaitingTeams).toBe(true);

    const after = await load();
    expect(after.useOrchestratorDraftStore.getState().drafts.t1?.awaitingTeams).toBe(true);
    after.useOrchestratorDraftStore.getState().reconcileTeam("t1", ["rnd", "alpha"]);
    expect(after.useOrchestratorDraftStore.getState().drafts.t1?.team).toBe("rnd");
    expect(kept(ORCHESTRATOR_KEY).state.drafts.t1).not.toHaveProperty("awaitingTeams");
  });

  it("still waits after an empty list and a reload, then settles", async () => {
    const before = await load();
    before.useOrchestratorDraftStore.getState().enter("t1", "env-a");
    before.useOrchestratorDraftStore.getState().reconcileTeam("t1", []);
    expect(kept(ORCHESTRATOR_KEY).state.drafts.t1.awaitingTeams).toBe(true);

    const after = await load();
    after.useOrchestratorDraftStore.getState().reconcileTeam("t1", ["rnd", "alpha"]);
    expect(after.useOrchestratorDraftStore.getState().drafts.t1?.team).toBe("rnd");
    expect(kept(ORCHESTRATOR_KEY).state.drafts.t1).toMatchObject({ team: "rnd" });
    expect(kept(ORCHESTRATOR_KEY).state.drafts.t1).not.toHaveProperty("awaitingTeams");
  });
});

describe("how the board is looked at", () => {
  const ENV = "env-a";
  const keep = (state: unknown, version = 2) =>
    storage.setItem(BOARD_KEY, JSON.stringify({ state, version }));
  /** A record of today's shape: the board of each environment, kept by its id. */
  const keepBoard = (preferences: Record<string, unknown>) =>
    keep({ deliveryEnvironment: ENV, preferencesByEnvironment: { [ENV]: preferences } });
  const boardAfterLoad = async () => {
    const { useBoardStore } = await load();
    const { boardPreferencesOf } = await import("./deliveryBoard");
    return boardPreferencesOf(useBoardStore.getState(), ENV);
  };
  const tagsAfterLoad = async (filters: unknown) => {
    keepBoard({ filters, view: "x" });
    return (await boardAfterLoad()).filters.tags;
  };
  const setFilters = (store: Awaited<ReturnType<typeof load>>, patch: Record<string, unknown>) =>
    store.useBoardStore
      .getState()
      .updateBoard(ENV, (current) => ({ filters: { ...current.filters, ...patch } }));

  it("lays the kept tags over filters that are otherwise off, and keeps the layout", async () => {
    keepBoard({ filters: { tags: ["a", "b"] }, view: "x", laneFolds: { intake: true } });
    const board = await boardAfterLoad();
    const { NO_FILTERS } = await import("../lib/deliveryBoard");
    expect(board.filters).toEqual({ ...NO_FILTERS, tags: ["a", "b"] });
    expect(board.view).toBe("x");
    expect(board.laneFolds).toEqual({ intake: true });
  });

  it("reads the one tag kept before several could be chosen", async () => {
    expect(await tagsAfterLoad({ tag: "cli" })).toEqual(["cli"]);
  });

  it("carries the tag over from the record kept before each environment had its board", async () => {
    keep({ deliveryEnvironment: ENV, filters: { tag: "cli" }, view: "x", person: "Sam" }, 1);
    const { useBoardStore } = await load();
    const { boardPreferencesOf } = await import("./deliveryBoard");
    const state = useBoardStore.getState();
    expect(boardPreferencesOf(state, ENV).filters.tags).toEqual(["cli"]);
    expect(boardPreferencesOf(state, ENV).view).toBe("x");
    expect(state.person).toBe("Sam");
  });

  it("puts a kept list before the one tag, an empty list too", async () => {
    expect(await tagsAfterLoad({ tags: [], tag: "x" })).toEqual([]);
    expect(await tagsAfterLoad({ tags: ["a"], tag: "x" })).toEqual(["a"]);
  });

  it("keeps only tags that are words, each once", async () => {
    expect(await tagsAfterLoad({ tags: [1, "", "a", "a", null] })).toEqual(["a"]);
    expect(await tagsAfterLoad({ tags: "a" })).toEqual([]);
    expect(await tagsAfterLoad({ tags: null })).toEqual([]);
    expect(await tagsAfterLoad({ tag: 7 })).toEqual([]);
  });

  it("has no tag chosen when no usable filters were kept", async () => {
    expect(await tagsAfterLoad(null)).toEqual([]);
    expect(await tagsAfterLoad("cli")).toEqual([]);
    expect(await tagsAfterLoad(undefined)).toEqual([]);
    keepBoard({ laneFolds: { intake: true } });
    const board = await boardAfterLoad();
    expect(board.filters.tags).toEqual([]);
    expect(board.filters.q).toBe("");
    expect(board.laneFolds).toEqual({ intake: true });
  });

  it("keeps the tags across a reload, and nothing else of the filters", async () => {
    const first = await load();
    setFilters(first, { tags: ["a", "b"], q: "zzz", priority: "high" });
    expect(kept(BOARD_KEY).state.preferencesByEnvironment[ENV].filters).toEqual({
      tags: ["a", "b"],
    });
    const board = await boardAfterLoad();
    expect(board.filters.tags).toEqual(["a", "b"]);
    expect(board.filters.q).toBe("");
    expect(board.filters.priority).toBeNull();
  });

  it("keeps each environment's tags apart", async () => {
    const first = await load();
    setFilters(first, { tags: ["a"] });
    first.useBoardStore
      .getState()
      .updateBoard("env-b", (current) => ({ filters: { ...current.filters, tags: ["b"] } }));
    const { useBoardStore } = await load();
    const { boardPreferencesOf } = await import("./deliveryBoard");
    expect(boardPreferencesOf(useBoardStore.getState(), ENV).filters.tags).toEqual(["a"]);
    expect(boardPreferencesOf(useBoardStore.getState(), "env-b").filters.tags).toEqual(["b"]);
  });

  it("takes one tag away through its chip and leaves the rest of the filters", async () => {
    const store = await load();
    const { activeFilters } = await import("../lib/deliveryBoard");
    const { boardPreferencesOf } = await import("./deliveryBoard");
    const filters = () => boardPreferencesOf(store.useBoardStore.getState(), ENV).filters;
    setFilters(store, { tags: ["a", "b"], q: "zzz", lanes: ["ready"] });
    const chip = activeFilters(filters(), (lane) => lane).find((item) => item.key === "tag:a");
    setFilters(store, chip!.clear);
    expect(filters()).toMatchObject({ tags: ["b"], q: "zzz", lanes: ["ready"] });
  });

  it("has no tag chosen after the filters are cleared, and after a reload", async () => {
    const first = await load();
    const { NO_FILTERS } = await import("../lib/deliveryBoard");
    setFilters(first, { tags: ["a", "b"] });
    first.useBoardStore.getState().updateBoard(ENV, () => ({ filters: NO_FILTERS }));
    expect((await boardAfterLoad()).filters.tags).toEqual([]);
  });
});
