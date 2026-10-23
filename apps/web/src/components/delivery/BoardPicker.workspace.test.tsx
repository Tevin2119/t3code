import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BoardDialog } from "./BoardPicker";

vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { environmentId: "local", title: "ILM", workspaceRoot: "/projects/ILM" },
    { environmentId: "remote", title: "Other", workspaceRoot: "/remote/Other" },
  ],
}));
vi.mock("../../state/delivery", () => ({
  useDeliveryRead: () => ({ body: [], refresh: vi.fn() }),
  useDeliveryAct: () => vi.fn(),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: "dialog",
  DialogPopup: "dialog-popup",
  DialogHeader: "dialog-header",
  DialogTitle: "dialog-title",
  DialogDescription: "dialog-description",
  DialogPanel: "dialog-panel",
  DialogFooter: "dialog-footer",
}));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectTrigger: "select-trigger",
  SelectValue: "select-value",
  SelectPopup: "select-popup",
  SelectItem: "select-item",
  SelectButton: "select-button",
}));
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("makes a folder board from a listed project without asking for a path or a repository", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const save = vi.fn();
  await act(() => {
    renderer = create(
      <BoardDialog
        kind="board"
        editing={null}
        environmentId={EnvironmentId.make("local")}
        workspace="/projects/ILM"
        busy={false}
        problem={null}
        onClose={() => {}}
        onSave={save}
      />,
    );
  });
  const options = renderer!.root
    .findAll((node) => String(node.type) === "select-item")
    .map((node) => node.props.value);
  expect(options).toContain("/projects/ILM");
  expect(options).not.toContain("/remote/Other");
  const button = renderer!.root.findByProps({ "data-board-dialog-save": true });
  expect(button.props.disabled).toBe(false);
  await act(() => button.props.onClick());
  expect(save).toHaveBeenCalledWith({ title: "ILM", description: "", workspace: "/projects/ILM" });
});
