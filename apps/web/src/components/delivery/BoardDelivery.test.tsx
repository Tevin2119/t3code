import { create } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { act } from "../../../test/act";
import { BoardDelivery } from "./BoardDelivery";
import { EnvironmentId } from "@t3tools/contracts";

const mock = vi.hoisted(() => ({ allowed: true, action: vi.fn(), snapshot: {} as unknown }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mock.allowed }));
vi.mock("../../state/delivery", () => ({
  deliveryEnvironment: { act: { permissionAtom: () => null } },
  useDeliveryAct: () => mock.action,
  useDeliveryRead: () => ({
    body: mock.snapshot,
    error: null,
    isPending: false,
    readAt: "now",
    refresh: vi.fn(),
  }),
  useStaleReading: () => false,
  usePersonName: () => "Sam",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "checkbox" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "select-popup",
  SelectTrigger: "select-trigger",
  SelectValue: "select-value",
}));

function setup() {
  mock.allowed = true;
  mock.action.mockReset();
  mock.action.mockResolvedValue({ ok: false, why: "Host unavailable" });
  mock.snapshot = {
    boards: [{ id: "board", title: "Board", repository: "repo", base: "main" }],
    routes: [
      {
        id: "route",
        board: "board",
        repository: "repo",
        base: "main",
        project: "prod",
        auto_merge: 0,
      },
    ],
    projects: [
      { id: "prod", repository: "repo", branch: "main", environment: "production", mode: "manual" },
    ],
    tracking: [],
  };
}

it("retries the same delivery request and clears the credential after refusal", async () => {
  setup();
  mock.action.mockRejectedValueOnce(new Error("Connection interrupted"));
  const screen = await act(() =>
    create(
      <BoardDelivery
        environmentId={EnvironmentId.make("host")}
        task={{ id: "task-a", origin: "thread:host/chat", repository: "repo", base: "main" }}
      />,
    ),
  );
  try {
    await act(() => screen.root.findByType("select").props.onValueChange("route"));
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(() =>
        screen.root
          .findByProps({ "aria-label": "Delivery approval passphrase" })
          .props.onChange({ target: { value: "test-only" } }),
      );
      const request = screen.root
        .findAllByType("button")
        .find((b) => b.children.includes("Request delivery"))!;
      expect(request.props.disabled).toBe(false);
      await act(() => request.props.onClick());
      expect(
        screen.root.findByProps({ "aria-label": "Delivery approval passphrase" }).props.value,
      ).toBe("");
    }
    expect(mock.action.mock.calls[0]).toEqual(mock.action.mock.calls[1]);
    expect(mock.action.mock.calls[0]?.[1]).toMatchObject({
      id: "delivery-task-a",
      origin: "thread:host/chat",
      task: "task-a",
    });
    mock.action.mockClear();
    await act(() =>
      screen.update(
        <BoardDelivery
          environmentId={EnvironmentId.make("host")}
          task={{
            id: "task-a",
            origin: "thread:host/chat",
            repository: "repo",
            base: "main",
            held: true,
          }}
        />,
      ),
    );
    await act(() =>
      screen.root
        .findByProps({ "aria-label": "Delivery approval passphrase" })
        .props.onChange({ target: { value: "test-only" } }),
    );
    const pausedRequest = screen.root
      .findAllByType("button")
      .find((b) => b.children.includes("Request delivery"))!;
    expect(pausedRequest.props.disabled).toBe(true);
    await act(() => pausedRequest.props.onClick());
    expect(mock.action).not.toHaveBeenCalled();
  } finally {
    await act(() => screen.unmount());
  }
});

it("does not submit a delivery mutation through a read-only connection", async () => {
  setup();
  mock.allowed = false;
  const screen = await act(() =>
    create(<BoardDelivery environmentId={EnvironmentId.make("host")} />),
  );
  try {
    expect(
      screen.root.findAllByType("button").find((b) => b.children.includes("Save route"))?.props
        .disabled,
    ).toBe(true);
    expect(mock.action).not.toHaveBeenCalled();
  } finally {
    await act(() => screen.unmount());
  }
});
