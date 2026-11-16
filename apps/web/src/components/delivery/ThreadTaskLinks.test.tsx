import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "../../../test/act";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { parseCards } from "../../lib/delivery";
import { ThreadTaskOpenActions } from "./ThreadTaskLinks";

const mock = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mock.navigate }));
vi.mock("lucide-react", () => ({ ChevronDownIcon: "svg" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("../../state/delivery", () => ({
  useDeliveryEnabled: () => false,
  useDeliveryRead: () => ({ body: null, error: null, readAt: null }),
  useStaleReading: () => false,
}));

const env = EnvironmentId.make("env-a");
const cards = (count: number) =>
  parseCards(
    Array.from({ length: count }, (_, index) => ({
      id: `task-${index + 1}`,
      number: 2249 - index,
      title: `Task ${index + 1}`,
      lane: "planning",
    })),
  );
let renderer: ReactTestRenderer;
const view = (count: number) => <ThreadTaskOpenActions tasks={cards(count)} environmentId={env} />;
const buttons = () => renderer.root.findAllByType("button");
const openButton = () => buttons()[0]!;
const textOf = (node: { children: ReadonlyArray<string | unknown> }): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : textOf(child as never)))
    .join("");
beforeEach(() => {
  mock.navigate.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
});

it("opens the only task straight from the button, without a dropdown", async () => {
  await act(() => {
    renderer = create(view(1));
  });
  expect(buttons()).toHaveLength(1);
  await act(() => openButton().props.onClick());
  expect(mock.navigate).toHaveBeenCalledWith({
    to: "/board",
    search: { task: "task-1", environment: env },
  });
});

it("lists every task made from the conversation and opens the chosen one", async () => {
  await act(() => {
    renderer = create(view(3));
  });
  const rendered = renderer.root.findAllByType("span").map(textOf).join(" ");
  expect(rendered).toContain("#2249 Task 1");
  expect(rendered).toContain("#2248 Task 2");
  expect(rendered).toContain("#2247 Task 3");
  expect(rendered).toContain("Planning");
  const items = buttons().slice(1);
  expect(items).toHaveLength(3);
  await act(() => items[2]!.props.onClick());
  expect(mock.navigate).toHaveBeenCalledWith({
    to: "/board",
    search: { task: "task-3", environment: env },
  });
  await act(() => openButton().props.onClick());
  expect(mock.navigate).toHaveBeenLastCalledWith({
    to: "/board",
    search: { task: "task-1", environment: env },
  });
});
