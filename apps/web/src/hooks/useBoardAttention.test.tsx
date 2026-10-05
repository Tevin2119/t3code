import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Reading = { readonly readAt: string; readonly body: unknown };
type Answer = { readonly body: unknown } | { readonly failure: string };

const engine = vi.hoisted(() => ({
  /** What each environment answers the next time it is read, by environment and path. */
  answers: new Map<string, unknown>(),
  atoms: new Map<string, unknown>(),
  reads: [] as Array<string>,
}));

// Beneath useDeliveryRead: the read family answers with what the test set, read again on a refresh.
vi.mock("@t3tools/client-runtime/state/delivery", () => ({
  createDeliveryEnvironmentAtoms: () => ({
    read: ({ environmentId, input }: { environmentId: string; input: { path: string } }) => {
      const key = `${environmentId} ${input.path}`;
      const existing = engine.atoms.get(key);
      if (existing) return existing;
      const atom = Atom.make((get): AsyncResult.AsyncResult<Reading, Error> => {
        engine.reads.push(key);
        const answer = engine.answers.get(key) as Answer | undefined;
        if (!answer) return AsyncResult.initial(true);
        if ("failure" in answer) {
          // As the real layer does: a refresh that fails keeps the reading before it.
          return AsyncResult.failureWithPrevious(Cause.fail(new Error(answer.failure)), {
            previous: get.self<AsyncResult.AsyncResult<Reading, Error>>(),
          });
        }
        // As the real layer does: every reading is a body of its own.
        return AsyncResult.success({
          readAt: "2026-10-04T09:00:00Z",
          body: structuredClone(answer.body),
        });
      });
      engine.atoms.set(key, atom);
      return atom;
    },
  }),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
// Only useDeliveryEnabled reads settings, and the hook is told whether delivery is on.
vi.mock("./useSettings", () => ({ useEnvironmentSettings: () => false }));

import { ATTENTION_BOARD_PATH } from "../lib/deliveryBoard";
import { useBoardAttention } from "./useBoardAttention";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

const board = (waiting: number, signOff = 0) => ({
  view: "development",
  set: "all",
  lanes: [
    { lane: "draft", title: "Draft", cards: [{ id: "draft-1", waitingOn: "person" }] },
    {
      lane: "needs-decision",
      title: "Needs your decision",
      cards: Array.from({ length: waiting }, (_, index) => ({ id: `waiting-${index}` })),
    },
    {
      lane: "human-review",
      title: "Your review",
      cards: Array.from({ length: signOff }, (_, index) => ({ id: `review-${index}` })),
    },
  ],
});
const MALFORMED = {
  view: "development",
  set: "all",
  lanes: [{ lane: "needs-decision", cards: "oops" }, { lane: "human-review" }],
};

/** A reading wrong only in listing one lane that counts twice: 1 is needs-decision, 2 is human-review. */
const twice = (index: 1 | 2, waiting: number, signOff = 0) => {
  const good = board(waiting, signOff);
  return { ...good, lanes: [...good.lanes, good.lanes[index]] };
};

const keyOf = (environmentId: EnvironmentId) => `${environmentId} ${ATTENTION_BOARD_PATH}`;
const answer = (environmentId: EnvironmentId, next: Answer) =>
  engine.answers.set(keyOf(environmentId), next);

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer;
let count: number | null = null;

type Around = { readonly enabled?: boolean; readonly connected?: boolean };

function Probe({
  environmentId,
  enabled = true,
  connected = true,
}: Around & { environmentId: EnvironmentId | null }) {
  const value = useBoardAttention(environmentId, enabled, connected);
  useLayoutEffect(() => {
    count = value;
  });
  return null;
}

const tree = (environmentId: EnvironmentId | null, around: Around = {}) => (
  <RegistryContext.Provider value={registry}>
    <Probe environmentId={environmentId} {...around} />
  </RegistryContext.Provider>
);
const mount = (environmentId: EnvironmentId | null, around?: Around) =>
  act(() => {
    renderer = create(tree(environmentId, around));
  });
const show = (environmentId: EnvironmentId | null, around?: Around) =>
  act(() => renderer.update(tree(environmentId, around)));
/** The next reading the sidebar takes by itself, with no Board page there to ask for one. */
const poll = () => act(() => vi.advanceTimersByTime(15_000));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { setInterval, clearInterval });
  vi.stubGlobal("document", { visibilityState: "visible" });
  engine.answers.clear();
  engine.atoms.clear();
  engine.reads.length = 0;
  registry = AtomRegistry.make();
  count = null;
});

afterEach(() => {
  act(() => renderer.unmount());
  registry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reads nothing and knows nothing while delivery is off or no environment is there", () => {
  answer(local, { body: board(3) });
  mount(local, { enabled: false });
  poll();
  expect(count).toBeNull();
  show(null);
  poll();
  expect(count).toBeNull();
  show(local, { connected: false });
  poll();
  expect(count).toBeNull();
  expect(engine.reads).toEqual([]);
});

it("does not know before the first reading, then counts both lanes", () => {
  mount(local);
  expect(count).toBeNull();
  answer(local, { body: board(2, 1) });
  poll();
  expect(count).toBe(3);
});

it("drops as tasks leave the lanes, down to none, from its own readings", () => {
  answer(local, { body: board(2) });
  mount(local);
  expect(count).toBe(2);
  answer(local, { body: board(1) });
  act(() => vi.advanceTimersByTime(14_999));
  expect(count).toBe(2);
  act(() => vi.advanceTimersByTime(1));
  expect(count).toBe(1);
  answer(local, { body: board(0) });
  poll();
  expect(count).toBe(0);
});

it("does not know when the first reading fails, and counts once one succeeds", () => {
  answer(local, { failure: "engine unreachable" });
  mount(local);
  expect(count).toBeNull();
  answer(local, { body: board(1) });
  poll();
  expect(count).toBe(1);
});

it("keeps the last count through a failed reading, and takes the next good one", () => {
  answer(local, { body: board(2) });
  mount(local);
  answer(local, { failure: "engine unreachable" });
  poll();
  expect(count).toBe(2);
  answer(local, { body: board(0) });
  poll();
  expect(count).toBe(0);
});

it("does not take a malformed answer for none", () => {
  answer(local, { body: MALFORMED });
  mount(local);
  expect(count).toBeNull();
  answer(local, { body: board(4) });
  poll();
  expect(count).toBe(4);
  answer(local, { body: MALFORMED });
  poll();
  expect(count).toBeNull();
  answer(local, { body: board(1) });
  poll();
  expect(count).toBe(1);
});

it("starts over for another environment, and ignores what the first one says after", () => {
  answer(local, { body: board(5) });
  mount(local);
  expect(count).toBe(5);
  // Nothing has been read from the new environment yet: the old count is not carried over.
  show(remote);
  expect(count).toBeNull();
  answer(remote, { body: MALFORMED });
  poll();
  expect(count).toBeNull();
  answer(local, { body: board(9) });
  act(() => registry.refresh(engine.atoms.get(keyOf(local)) as Atom.Atom<unknown>));
  expect(count).toBeNull();
  answer(remote, { body: board(1) });
  poll();
  expect(count).toBe(1);
});

it("does not bring a count back when the environment is left and returned to", () => {
  answer(local, { body: board(5) });
  mount(local);
  expect(count).toBe(5);
  // The other environment never answers, so nothing is known of it.
  show(remote);
  poll();
  expect(count).toBeNull();
  // Back on the first one, the reading at hand is the one from before leaving.
  show(local);
  expect(count).toBeNull();
  answer(local, { failure: "engine unreachable" });
  poll();
  expect(count).toBeNull();
  answer(local, { body: board(3) });
  poll();
  expect(count).toBe(3);
});

it("clears the count on a card that is not one, among good ones", () => {
  answer(local, { body: board(2, 1) });
  mount(local);
  expect(count).toBe(3);
  const mixed = board(2, 1);
  answer(local, {
    body: { ...mixed, lanes: [...mixed.lanes, { lane: "ready", cards: [{ id: "a" }, null] }] },
  });
  poll();
  expect(count).toBeNull();
  answer(local, {
    body: {
      ...mixed,
      lanes: [mixed.lanes[0], { lane: "needs-decision", cards: [null] }, mixed.lanes[2]],
    },
  });
  poll();
  expect(count).toBeNull();
  answer(local, { body: board(0) });
  poll();
  expect(count).toBe(0);
});

it("forgets the count on a disconnect while delivery stays on, and reads again once connected", () => {
  answer(local, { body: board(2) });
  mount(local);
  expect(count).toBe(2);
  // The settings kept from before the disconnect still say delivery is on.
  show(local, { enabled: true, connected: false });
  expect(count).toBeNull();
  const reads = engine.reads.length;
  answer(local, { body: board(7) });
  poll();
  expect(count).toBeNull();
  expect(engine.reads).toHaveLength(reads);
  // Connected again: the reading from before is not shown, the next one is.
  show(local, { enabled: true, connected: true });
  expect(count).toBeNull();
  answer(local, { failure: "engine unreachable" });
  poll();
  expect(count).toBeNull();
  answer(local, { body: board(1) });
  poll();
  expect(count).toBe(1);
});

it("forgets the count when delivery is turned off", () => {
  answer(local, { body: board(2) });
  mount(local);
  expect(count).toBe(2);
  show(local, { enabled: false });
  expect(count).toBeNull();
  answer(local, { body: MALFORMED });
  show(local);
  poll();
  expect(count).toBeNull();
  answer(local, { body: board(1) });
  poll();
  expect(count).toBe(1);
});

it.each([
  ["needs-decision", 1],
  ["human-review", 2],
] as const)("does not count a reading that lists %s twice", (_lane, index) => {
  // As the first reading: not known, and still not after the same again.
  answer(local, { body: twice(index, 2, 1) });
  mount(local);
  expect(count).toBeNull();
  poll();
  expect(count).toBeNull();
  answer(local, { body: board(2, 1) });
  poll();
  expect(count).toBe(3);
  // After a count: the number goes rather than staying or growing.
  answer(local, { body: twice(index, 2, 1) });
  poll();
  expect(count).toBeNull();
  poll();
  expect(count).toBeNull();
  answer(local, { body: board(1) });
  poll();
  expect(count).toBe(1);
  answer(local, { body: twice(index, 0) });
  poll();
  expect(count).toBeNull();
  answer(local, { body: board(0) });
  poll();
  expect(count).toBe(0);
});

it("does not bring an earlier count back when a reading fails after a lane listed twice", () => {
  answer(local, { body: board(2, 1) });
  mount(local);
  expect(count).toBe(3);
  answer(local, { body: twice(1, 2, 1) });
  poll();
  expect(count).toBeNull();
  // The failed reading hands back the body before it, which is the one listed twice.
  answer(local, { failure: "engine unreachable" });
  poll();
  expect(count).toBeNull();
  poll();
  expect(count).toBeNull();
  answer(local, { body: board(2, 1) });
  poll();
  expect(count).toBe(3);
});
