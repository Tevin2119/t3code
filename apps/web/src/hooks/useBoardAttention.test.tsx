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
        return AsyncResult.success({ readAt: "2026-10-04T09:00:00Z", body: answer.body });
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

const keyOf = (environmentId: EnvironmentId) => `${environmentId} ${ATTENTION_BOARD_PATH}`;
const answer = (environmentId: EnvironmentId, next: Answer) =>
  engine.answers.set(keyOf(environmentId), next);

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer;
let count: number | null = null;

function Probe({
  environmentId,
  enabled,
}: {
  environmentId: EnvironmentId | null;
  enabled: boolean;
}) {
  const value = useBoardAttention(environmentId, enabled);
  useLayoutEffect(() => {
    count = value;
  });
  return null;
}

const tree = (environmentId: EnvironmentId | null, enabled = true) => (
  <RegistryContext.Provider value={registry}>
    <Probe environmentId={environmentId} enabled={enabled} />
  </RegistryContext.Provider>
);
const mount = (environmentId: EnvironmentId | null, enabled = true) =>
  act(() => {
    renderer = create(tree(environmentId, enabled));
  });
const show = (environmentId: EnvironmentId | null, enabled = true) =>
  act(() => renderer.update(tree(environmentId, enabled)));
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
  mount(local, false);
  poll();
  expect(count).toBeNull();
  show(null, true);
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
  expect(count).toBe(4);
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

it("forgets the count when the environment disconnects or delivery is turned off", () => {
  answer(local, { body: board(2) });
  mount(local);
  expect(count).toBe(2);
  // A disconnected environment reads its default settings, where delivery is off.
  show(local, false);
  expect(count).toBeNull();
  answer(local, { body: MALFORMED });
  show(local, true);
  poll();
  expect(count).toBeNull();
  answer(local, { body: board(1) });
  poll();
  expect(count).toBe(1);
});
