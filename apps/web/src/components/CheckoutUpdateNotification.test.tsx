import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { CheckoutUpdateState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  environmentId: "env-a" as string | null,
  supported: true as boolean | null,
  checkout: null as unknown,
  hydrated: true,
  legacy: false,
  pathname: "/",
  start: vi.fn(),
  setStorage: vi.fn(),
  dismissed: null as string | null,
  toastAdd: vi.fn(),
  toastClose: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    testState.supported === null
      ? null
      : { environment: { capabilities: { checkoutUpdate: testState.supported } } },
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) =>
    select({ pathname: testState.pathname }),
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => testState.environmentId,
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({ data: atom === null ? null : testState.checkout }),
}));
vi.mock("../state/server", () => ({
  primaryServerConfigAtom: Symbol("config"),
  serverEnvironment: {
    checkoutUpdateState: () => Symbol("checkoutUpdateState"),
    startCheckoutUpdate: Symbol("startCheckoutUpdate"),
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => testState.start }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => testState.hydrated,
  useLegacySidebarEnabled: () => testState.hydrated && testState.legacy,
}));
vi.mock("../hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => testState.dismissed,
  setLocalStorageItem: testState.setStorage,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toastAdd, close: testState.toastClose },
  stackedThreadToast: (toast: unknown) => toast,
  hiddenToastActionProps: {},
}));

import {
  CheckoutUpdateProvider,
  useCheckoutUpdatePill,
  type CheckoutUpdatePillModel,
} from "./CheckoutUpdateNotification";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const offered: CheckoutUpdateState = {
  running: { commit: A, subject: "Older work" },
  available: { commit: B, subject: "Newer work", behind: 2 },
  phase: "idle",
  message: null,
  checkedAt: null,
  lastOutcome: null,
};
const updated: CheckoutUpdateState = {
  ...offered,
  running: { commit: B, subject: "Newer work" },
  available: null,
};
const success = AsyncResult.success(undefined);

let pill: CheckoutUpdatePillModel | null = null;
function Probe() {
  const current = useCheckoutUpdatePill();
  useEffect(() => {
    pill = current;
  });
  return null;
}

let renderer: ReactTestRenderer | undefined;
const app = () => (
  <CheckoutUpdateProvider enabled>
    <Probe />
  </CheckoutUpdateProvider>
);
async function mount() {
  await act(async () => {
    renderer = create(app());
  });
}
async function serverSays(change: Partial<typeof testState>) {
  Object.assign(testState, change);
  await act(async () => {
    renderer!.update(app());
  });
}
function deferred() {
  let resolve!: (value: unknown) => void;
  testState.start.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
  return (value: unknown) => act(async () => resolve(value));
}
const toastTitles = () => testState.toastAdd.mock.calls.map(([toast]) => toast.title);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { location: { reload: testState.reload } });
  Object.assign(testState, {
    environmentId: "env-a",
    supported: true,
    checkout: offered,
    hydrated: true,
    legacy: false,
    pathname: "/",
    dismissed: null,
  });
  for (const mock of [
    testState.start,
    testState.setStorage,
    testState.toastAdd,
    testState.toastClose,
    testState.reload,
  ]) {
    mock.mockReset();
  }
  testState.toastAdd.mockImplementation(() => `toast-${testState.toastAdd.mock.calls.length}`);
  pill = null;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("CheckoutUpdateProvider", () => {
  it("offers the update in the pill, not a toast, with the v2 sidebar", async () => {
    await mount();
    expect(pill?.view).toMatchObject({
      title: "T3 update available",
      description: "Newer work · 2 new commits",
      action: "update",
    });
    expect(testState.toastAdd).not.toHaveBeenCalled();
  });

  it("starts once however often it is pressed, until the server moves on", async () => {
    await mount();
    const finish = deferred();
    await act(async () => {
      pill!.start();
      pill!.start();
    });
    expect(testState.start).toHaveBeenCalledTimes(1);
    expect(pill?.view.action).toBe("starting");
    await finish(success);
    expect(pill?.view.action).toBe("starting");
    await act(async () => pill!.start());
    expect(testState.start).toHaveBeenCalledTimes(1);

    await serverSays({ checkout: { ...offered, phase: "installing" } });
    expect(pill?.view).toMatchObject({ title: "Installing the T3 update", action: null });
    await serverSays({ checkout: { ...offered, phase: "building" } });
    expect(pill?.view.title).toBe("Building the T3 update");
    await serverSays({ checkout: { ...offered, phase: "restarting" } });
    expect(pill?.view.title).toBe("Restarting T3");
  });

  it("says a start that failed did not start, and lets the person try again", async () => {
    await mount();
    testState.start.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
    await act(async () => pill!.start());
    expect(pill?.view).toMatchObject({
      action: "update",
      notice: "The update did not start. Try again.",
    });
    testState.start.mockResolvedValueOnce(success);
    await act(async () => pill!.start());
    expect(testState.start).toHaveBeenCalledTimes(2);
  });

  it("releases the button when the supervisor passes on the request", async () => {
    await mount();
    testState.start.mockResolvedValueOnce(success);
    await act(async () => pill!.start());
    expect(pill?.view.action).toBe("starting");
    await serverSays({ checkout: { ...offered, checkedAt: "2026-10-08T00:00:00.000Z" } });
    expect(pill?.view.action).toBe("update");
  });

  it("reloads the tab that started the update, through a reconnect and a visit to Settings", async () => {
    await mount();
    testState.start.mockResolvedValueOnce(success);
    await act(async () => pill!.start());
    await serverSays({ checkout: { ...offered, phase: "restarting" } });
    await serverSays({ checkout: null, supported: null, pathname: "/settings/connections" });
    expect(pill).toBeNull();
    await serverSays({ pathname: "/" });
    expect(pill?.view.title).toBe("Restarting T3");
    expect(testState.reload).not.toHaveBeenCalled();
    await serverSays({ checkout: updated, supported: true });
    expect(testState.reload).toHaveBeenCalledTimes(1);
  });

  it("offers Reload in a tab that did not start the update", async () => {
    await mount();
    await serverSays({ checkout: { ...offered, phase: "restarting" } });
    await serverSays({ checkout: updated });
    expect(testState.reload).not.toHaveBeenCalled();
    expect(pill?.view).toMatchObject({ title: "T3 was updated", action: "reload" });
    pill!.reload();
    expect(testState.reload).toHaveBeenCalledTimes(1);
  });

  it("shows an undone update until closed, and does not reload for it", async () => {
    await mount();
    testState.start.mockResolvedValueOnce(success);
    await act(async () => pill!.start());
    await serverSays({
      checkout: {
        ...offered,
        phase: "failed",
        message: "bbbbbbb did not start. T3 went back to aaaaaaa.",
        lastOutcome: { from: A, to: B, status: "rolled-back", reason: "bbbbbbb did not start." },
      },
    });
    expect(pill?.view).toMatchObject({ title: "T3 update undone", tone: "error" });
    await act(async () => pill!.close());
    expect(pill).toBeNull();
    expect(testState.setStorage).not.toHaveBeenCalled();
    expect(testState.reload).not.toHaveBeenCalled();
  });

  it("remembers a dismissed offer until a newer commit, in both pill and toast", async () => {
    await mount();
    await act(async () => pill!.close());
    expect(testState.setStorage).toHaveBeenCalledWith(
      "t3code:checkout-update-dismissed:v1",
      B,
      expect.anything(),
    );
    expect(pill).toBeNull();
    await serverSays({ pathname: "/settings" });
    expect(testState.toastAdd).not.toHaveBeenCalled();
    await serverSays({
      checkout: { ...offered, available: { commit: C, subject: "", behind: 3 } },
    });
    expect(toastTitles()).toEqual(["T3 update available"]);
  });

  it("closes the toast without remembering a dismissal when it moves to the pill", async () => {
    testState.pathname = "/settings";
    await mount();
    expect(toastTitles()).toEqual(["T3 update available"]);
    await serverSays({ pathname: "/" });
    expect(testState.toastClose).toHaveBeenCalledWith("toast-1");
    expect(testState.setStorage).not.toHaveBeenCalled();
    expect(pill?.view.action).toBe("update");
  });

  it("keeps the toast with the legacy sidebar, with its actions", async () => {
    testState.legacy = true;
    await mount();
    expect(pill).toBeNull();
    const toast = testState.toastAdd.mock.calls[0]![0];
    expect(toast.actionProps.children).toBe("Update and restart");
    testState.start.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
    await act(async () => toast.actionProps.onClick());
    expect(toastTitles()).toEqual(["T3 update available", "T3 could not start the update"]);
    await act(async () => toast.data.onClose());
    expect(testState.setStorage).toHaveBeenCalledTimes(1);
  });

  it("shows nothing before settings load or for a server without the capability", async () => {
    testState.hydrated = false;
    await mount();
    expect(pill).toBeNull();
    await serverSays({ hydrated: true, supported: false });
    expect(pill).toBeNull();
    await serverSays({ legacy: true });
    expect(testState.toastAdd).not.toHaveBeenCalled();
  });

  it.each([
    ["success", success],
    ["failure", AsyncResult.failure(Cause.fail(new Error("offline")))],
  ])("ignores a %s that lands after the primary environment changed", async (_, result) => {
    await mount();
    const finish = deferred();
    await act(async () => pill!.start());
    await serverSays({ environmentId: "env-b" });
    await finish(result);
    expect(pill?.view).toMatchObject({ action: "update", notice: null });
    await serverSays({ checkout: updated });
    expect(testState.reload).not.toHaveBeenCalled();
  });
});
