import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BoardSeatsDialog } from "./BoardSeatsDialog";

const mock = vi.hoisted(() => ({
  reading: { body: null as unknown, error: null as string | null, refresh: () => {} },
  action: vi.fn(),
}));
vi.mock("../../state/delivery", () => ({
  useDeliveryRead: () => mock.reading,
  useDeliveryAct: () => mock.action,
  usePersonName: () => "person",
  withSeatChoice: (chosen: Record<string, unknown>, seat: string, choice: unknown) => ({
    ...chosen,
    [seat]: choice,
  }),
}));
vi.mock("./SeatSettingsPanel", () => ({ SeatSettingsPanel: () => null }));
vi.mock("./FallbacksEditor", () => ({ FallbacksEditor: () => null }));
vi.mock("./TrackRecord", () => ({ TrackRecord: () => null }));
vi.mock("./Behind", () => ({ Behind: () => null }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/dialog", () => {
  const Pass = (props: { children?: ReactNode }) => <div>{props.children}</div>;
  return {
    Dialog: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogPanel: Pass,
    DialogPopup: Pass,
    DialogTitle: Pass,
  };
});

let renderer: ReactTestRenderer;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mock.reading.body = {
    teams: [
      {
        team: "development",
        revision: 3,
        seats: [{ seat: "builder", title: "Builder", harness: "codex", role: "build" }],
      },
    ],
  };
  mock.action.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
});

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");

async function saveRefused(refusal: Record<string, unknown>) {
  mock.action.mockResolvedValue({ ok: false, status: 400, ...refusal });
  await act(() => {
    renderer = create(
      <BoardSeatsDialog
        environmentId={"env-1" as never}
        board={{ id: "pilot", title: "Pilot" }}
        onClose={() => {}}
      />,
    );
  });
  const save = renderer.root.find((node) => node.props["data-board-seats-save"] === true);
  await act(async () => {
    await save.props.onClick();
  });
  return renderer.root.findAll((node) => node.props["data-delivery-problem"] === true);
}

describe("BoardSeatsDialog", () => {
  it("shows the engine's own words when it refuses a reasoning level on save", async () => {
    const engine = 'builder: codex takes low, medium, high for reasoning, not "max"';
    const shown = await saveRefused({
      why: "The delivery engine refused the request.",
      problems: [engine],
    });
    expect(mock.action).toHaveBeenCalledWith(
      "/api/boards/pilot/seats",
      expect.objectContaining({ revision: 3 }),
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]!.props.role).toBe("alert");
    expect(text(shown[0]!)).toBe(engine);
  });

  it("shows the engine's reason when a refusal names no problems", async () => {
    const shown = await saveRefused({
      why: "gpt-5 takes no reasoning level max on codex 0.130",
      problems: [],
    });
    expect(text(shown[0]!)).toBe("gpt-5 takes no reasoning level max on codex 0.130");
  });
});
