import {
  EnvironmentId,
  ProviderInstanceId,
  type DeliveryOrchestrationConfig,
} from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TeamBadge } from "./TeamBadge";

const testState = vi.hoisted(() => ({
  threadState: { data: null } as { data: unknown },
}));

vi.mock("../../state/delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/delivery")>()),
  useDeliveryEnabled: () => true,
  useDeliveryRead: () => ({
    body: null,
    readAt: null,
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: testState.threadState.data,
    error: null,
    refresh: () => {},
  }),
}));

const ENV = EnvironmentId.make("env-a");
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

async function render() {
  await act(async () => {
    renderer = create(<TeamBadge environmentId={ENV} threadId={"t1" as never} />);
  });
}

const badge = (value: string) =>
  renderer!.root.findAllByProps({ "data-delivery-team-badge": value });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.threadState = { data: null };
  renderer = undefined;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("the badge of a started conversation", () => {
  it("names how many participants receive the next message on a teamless lineup", async () => {
    testState.threadState = { data: { binding: null, lineup: LINEUP, pending: null } };
    await render();

    const participants = badge("participants");
    expect(participants.length).toBeGreaterThan(0);
    expect(participants[0]!.props["aria-label"]).toBe("2 participants receive the next message");
    expect(badge("none")).toEqual([]);
  });

  it("still says No team for an ordinary conversation", async () => {
    testState.threadState = { data: { binding: null, lineup: null, pending: null } };
    await render();

    expect(badge("none")).toHaveLength(1);
    expect(badge("participants")).toEqual([]);
  });

  it("keeps the bound thread's badge on its team and role", async () => {
    testState.threadState = {
      data: {
        binding: {
          threadId: "t1",
          session: "session-1",
          team: "research",
          role: "reviewer",
          seat: "critic",
          harness: "codex",
          driver: "codex",
          workspace: "/repo",
          configuration: "research@1#digest",
          requestedModel: null,
          memoryScope: "conversation",
          tools: [],
          project: "project-1",
          boundAt: "2026-01-01T00:00:00.000Z",
        },
        lineup: LINEUP,
        pending: null,
      },
    };
    await render();

    expect(badge("research").length).toBeGreaterThan(0);
    expect(badge("participants")).toEqual([]);
  });
});
