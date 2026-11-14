import {
  EnvironmentId,
  ProviderInstanceId,
  type DeliveryOrchestrationConfig,
  type ModelSelection,
} from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../ui/toast";
import { TeamChatToggle } from "./TeamChatToggle";

interface ThreadState {
  data: unknown;
}
const testState = vi.hoisted(() => ({
  threadState: { data: null } as ThreadState,
  forkSourceState: { data: null } as ThreadState,
  refreshed: 0,
  setLineup: vi.fn(async (_input: unknown): Promise<{ _tag: string }> => ({ _tag: "Success" })),
}));

vi.mock("../../state/delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/delivery")>()),
  useDeliveryEnabled: () => true,
  deliveryEnvironment: {
    threadBinding: (input: { input: { threadId: string } }) => input.input.threadId,
    setThreadLineup: {},
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (threadId: string | null) => ({
    data:
      threadId === null
        ? undefined
        : threadId === "t1"
          ? testState.threadState.data
          : testState.forkSourceState.data,
    refresh: () => {
      testState.refreshed += 1;
    },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => testState.setLineup,
}));

const ENV = EnvironmentId.make("env-a");
const LEAD: ModelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };
const LINEUP: DeliveryOrchestrationConfig = {
  participants: [
    {
      seat: "scout",
      role: "researcher",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "m1" },
    },
    {
      seat: "critic",
      role: "reviewer",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "c1" },
    },
  ],
};

let renderer: ReactTestRenderer | undefined;

async function render(
  props: {
    leadModelSelection?: ModelSelection | null;
    onRestoreLead?: (selection: ModelSelection) => void;
    forkedFromThreadId?: string;
    onOpenForkSource?: (threadId: string) => void;
  } = {},
) {
  await act(async () => {
    renderer = create(
      <TeamChatToggle
        environmentId={ENV}
        threadId={"t1" as never}
        leadModelSelection={props.leadModelSelection ?? null}
        {...(props.onRestoreLead ? { onRestoreLead: props.onRestoreLead } : {})}
        {...(props.forkedFromThreadId
          ? { forkedFromThreadId: props.forkedFromThreadId as never }
          : {})}
        {...(props.onOpenForkSource ? { onOpenForkSource: props.onOpenForkSource as never } : {})}
      />,
    );
  });
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const toggleButton = (state: "team" | "single" | "fork") =>
  renderer!.root.findByProps({ "data-delivery-team-toggle": state });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.threadState = { data: null };
  testState.forkSourceState = { data: null };
  testState.refreshed = 0;
  testState.setLineup.mockClear();
  renderer = undefined;
  vi.spyOn(toastManager, "add").mockImplementation(() => 0 as never);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the single/team toggle of a started conversation", () => {
  it("shows Team chat while a lineup runs, and switches to single by clearing it", async () => {
    testState.threadState = { data: { binding: null, lineup: LINEUP } };
    await render({ leadModelSelection: LEAD });

    expect(toggleButton("team").props["aria-pressed"]).toBe(true);
    await act(async () => {
      toggleButton("team").props.onClick();
    });
    await flush();

    // The server remembers the team with the thread's model as the lead's.
    expect(testState.setLineup).toHaveBeenCalledWith({
      environmentId: ENV,
      input: { threadId: "t1", orchestration: null, rememberLeadModelSelection: LEAD },
    });
    expect(testState.refreshed).toBe(1);
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("brings the remembered team back and restores its lead model", async () => {
    const onRestoreLead = vi.fn();
    testState.threadState = {
      data: {
        binding: null,
        lineup: null,
        rememberedLineup: { orchestration: LINEUP, leadModelSelection: LEAD },
      },
    };
    await render({ onRestoreLead });

    expect(toggleButton("single").props["aria-pressed"]).toBe(false);
    await act(async () => {
      toggleButton("single").props.onClick();
    });
    await flush();

    expect(testState.setLineup).toHaveBeenCalledWith({
      environmentId: ENV,
      input: { threadId: "t1", orchestration: LINEUP },
    });
    expect(onRestoreLead).toHaveBeenCalledWith(LEAD);
    expect(testState.refreshed).toBe(1);
  });

  it("says where teams start instead of failing for a conversation that was never a team", async () => {
    testState.threadState = { data: { binding: null, lineup: null } };
    await render();

    await act(async () => {
      toggleButton("single").props.onClick();
    });
    await flush();

    expect(testState.setLineup).not.toHaveBeenCalled();
    expect(testState.refreshed).toBe(0);
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", title: expect.stringContaining("no team") }),
    );
  });

  it("goes back to the team conversation from a 1:1 fork that has no team of its own", async () => {
    const onOpenForkSource = vi.fn();
    testState.threadState = { data: { binding: null, lineup: null } };
    testState.forkSourceState = { data: { binding: null, lineup: LINEUP } };
    await render({ forkedFromThreadId: "team-thread", onOpenForkSource });

    await act(async () => {
      toggleButton("fork").props.onClick();
    });
    await flush();

    expect(onOpenForkSource).toHaveBeenCalledWith("team-thread");
    expect(testState.setLineup).not.toHaveBeenCalled();
    expect(toastManager.add).not.toHaveBeenCalled();

    // Starting the 1:1 left the team conversation in single chat: its team comes back too.
    testState.forkSourceState = {
      data: { binding: null, lineup: null, rememberedLineup: { orchestration: LINEUP } },
    };
    await act(async () => renderer?.unmount());
    await render({ forkedFromThreadId: "team-thread", onOpenForkSource });
    await act(async () => {
      toggleButton("fork").props.onClick();
    });
    await flush();
    expect(testState.setLineup).toHaveBeenCalledWith({
      environmentId: ENV,
      input: { threadId: "team-thread", orchestration: LINEUP },
    });
    expect(onOpenForkSource).toHaveBeenCalledTimes(2);
  });

  it("warns and keeps the team when clearing the lineup is refused", async () => {
    testState.setLineup.mockResolvedValueOnce({ _tag: "Failure" });
    testState.threadState = { data: { binding: null, lineup: LINEUP } };
    await render({ leadModelSelection: LEAD });

    await act(async () => {
      toggleButton("team").props.onClick();
    });
    await flush();

    expect(testState.setLineup).toHaveBeenCalledTimes(1);
    expect(testState.refreshed).toBe(0);
    expect(toastManager.add).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
  });

  it("renders nothing while the conversation's state is unknown", async () => {
    testState.threadState = { data: undefined };
    await render();
    expect(renderer!.root.findAllByProps({ "data-delivery-team-toggle": "team" })).toEqual([]);
    expect(renderer!.root.findAllByProps({ "data-delivery-team-toggle": "single" })).toEqual([]);
  });
});
