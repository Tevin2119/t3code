import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TaskTeamHeader } from "./TaskTeamHeader";

const setLineup = vi.fn();
const seat = (name: string, role: string, harness: string, title: string) => ({
  seat: name,
  role,
  harness,
  title,
  model: `${harness}-model`,
  available: true,
  why: null,
});
const TEAMS = [
  {
    team: "development",
    purpose: "Builds.",
    available: true,
    seats: [
      seat("lead", "team-lead", "claude", "Lead"),
      seat("builder", "builder", "codex", "Builder"),
    ],
    settings: [],
  },
];
const lineup = {
  team: "development",
  participants: [
    {
      seat: "builder",
      role: "builder",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "codex-model" },
    },
  ],
};

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
    data: { binding: null, boardLineup: lineup, pending: null },
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => setLineup }));

it("shows a board task's team and lead, then its seats, with nothing to change", async () => {
  await using _screen = await render(
    <TaskTeamHeader
      environmentId={"env-a" as never}
      threadId={"t1" as never}
      driver={ProviderDriverKind.make("claudeAgent")}
      entries={[]}
      models={new Map()}
      leadModelSelection={{ instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" }}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "1 seat in this task's team" }))
    .toBeVisible();
  await expect.element(page.getByText("Team development")).toBeVisible();
  await expect.element(page.getByText(/The board picks this task's team and models/)).toBeVisible();
  await expect
    .element(page.getByText("Send a message to start the conversation."))
    .not.toBeInTheDocument();
  expect(setLineup).not.toHaveBeenCalled();
});
