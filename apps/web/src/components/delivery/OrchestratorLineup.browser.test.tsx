import {
  ProviderDriverKind,
  ProviderInstanceId,
  type DeliveryOrchestrationConfig,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { OrchestratorLineup } from "./OrchestratorLineup";

const testState = vi.hoisted(() => ({
  threadState: { data: null } as { data: unknown },
  // Like the server: a saved lineup is what the next render reads.
  setLineup: vi.fn(async (input: { input: { orchestration: unknown } }) => {
    testState.threadState.data = {
      ...(testState.threadState.data as object),
      lineup: input.input.orchestration,
    };
    return { _tag: "Success" };
  }),
}));

vi.mock("../../state/delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/delivery")>()),
  useDeliveryEnabled: () => true,
  useDeliveryRead: (_environmentId: string | null, path: string) => ({
    body: path === "/api/teams" ? TEAMS : null,
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
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => testState.setLineup,
}));

const seat = (name: string, role: string, harness: string, title: string) => ({
  seat: name,
  role,
  harness,
  title,
  model: `${harness}-model`,
  available: true,
  why: null,
});
const setting = (name: string, role: string, harness: string) => ({
  seat: name,
  harness,
  now: { model: `${harness}-model`, reasoning: null, access: "full" },
  may: { model: true, reasoning: [], access: ["full"] },
  why: { model: null, reasoning: null, access: null },
});
const TEAMS = [
  {
    team: "research",
    purpose: "Research.",
    available: true,
    seats: [
      seat("scout", "researcher", "claude", "Scout"),
      seat("critic", "reviewer", "codex", "Critic"),
      seat("analyst", "analyzer", "codex", "Analyst"),
    ],
    settings: [
      setting("scout", "researcher", "claude"),
      setting("critic", "reviewer", "codex"),
      setting("analyst", "analyzer", "codex"),
    ],
  },
];

const ENTRIES = deriveProviderInstanceEntries(
  (["claudeAgent", "codex"] as const).map((driver) => ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  })),
);
const MODELS = new Map(ENTRIES.map((entry) => [entry.instanceId, entry.models]));

const LINEUP: DeliveryOrchestrationConfig = {
  participants: [
    {
      seat: "scout",
      role: "researcher",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-model" },
    },
    {
      seat: "critic",
      role: "reviewer",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "codex-model" },
    },
  ],
};

const LINEUP_OF_THREE: DeliveryOrchestrationConfig = {
  participants: [
    ...LINEUP.participants,
    {
      seat: "analyst",
      role: "analyzer",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "codex-model" },
    },
  ],
};

const RESEARCH_BINDING = {
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
};

it("applies a member toggle as it is made, with no apply button", async () => {
  const onLeaveToSingle = vi.fn();
  testState.threadState = {
    data: { binding: RESEARCH_BINDING, lineup: LINEUP_OF_THREE, pending: null },
  };
  testState.setLineup.mockClear();
  await using _screen = await render(
    <OrchestratorLineup
      environmentId={"env-a" as never}
      threadId={"t1" as never}
      driver={ProviderDriverKind.make("codex")}
      entries={ENTRIES}
      models={MODELS}
      onLeaveToSingle={onLeaveToSingle}
    />,
  );

  expect(page.getByRole("button", { name: "Use from the next message" })).not.toBeInTheDocument();
  await page.getByRole("checkbox", { name: "Include Scout" }).click();
  await vi.waitFor(() => {
    expect(testState.setLineup).toHaveBeenCalledWith({
      environmentId: "env-a",
      input: {
        threadId: "t1",
        orchestration: {
          participants: LINEUP_OF_THREE.participants.filter(
            (participant) => participant.seat !== "scout",
          ),
        },
      },
    });
  });

  // A change that would stop being a team stays visible, unsaved, with its reason.
  await page.getByRole("checkbox", { name: "Include Critic" }).click();
  expect(testState.setLineup).toHaveBeenCalledTimes(1);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Choose between 2 and 12 participants.");

  // Leaving for ordinary chat is the composer's path, so the team is remembered.
  await page.getByRole("button", { name: "Use ordinary chat" }).click();
  expect(onLeaveToSingle).toHaveBeenCalled();
  expect(testState.setLineup).toHaveBeenCalledTimes(1);
});

it("starts a 1:1 chat from a participant without touching the team's lineup", async () => {
  const onFocusChat = vi.fn();
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
  testState.setLineup.mockClear();
  await using _screen = await render(
    <OrchestratorLineup
      environmentId={"env-a" as never}
      threadId={"t1" as never}
      driver={ProviderDriverKind.make("codex")}
      entries={ENTRIES}
      models={MODELS}
      onFocusChat={onFocusChat}
    />,
  );

  // The orchestrator's own seat is this conversation: no 1:1 for it.
  await expect
    .element(page.getByRole("button", { name: "Chat 1:1 with Critic" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Chat 1:1 with Scout" }).click();
  expect(onFocusChat).toHaveBeenCalledWith({
    role: "researcher",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-model" },
  });
  // Focusing one member changes nothing for the team conversation.
  expect(testState.setLineup).not.toHaveBeenCalled();
});

it("offers a 1:1 chat with a teamless participant's harness and model", async () => {
  const onFocusChat = vi.fn();
  testState.threadState = {
    data: { binding: null, lineup: LINEUP, pending: null },
  };
  await using _screen = await render(
    <OrchestratorLineup
      environmentId={"env-a" as never}
      threadId={"t1" as never}
      driver={ProviderDriverKind.make("codex")}
      entries={ENTRIES}
      models={MODELS}
      onFocusChat={onFocusChat}
    />,
  );

  await page.getByRole("button", { name: "Chat 1:1 with Extra participant 2" }).click();
  expect(onFocusChat).toHaveBeenCalledWith({
    role: "reviewer",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "codex-model" },
  });
});
