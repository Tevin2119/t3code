import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";

vi.mock("./composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("./ComposerControl", () => ({ ComposerControl: "button", ComposerControlIcon: "icon" }));
vi.mock("../ui/menu", () => ({
  Menu: "menu",
  MenuItem: "menu-item",
  MenuPopup: "menu-popup",
  MenuRadioGroup: "menu-radio-group",
  MenuRadioItem: "menu-radio-item",
  MenuSeparator: "separator",
  MenuTrigger: "menu-trigger",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: "dialog",
  DialogHeader: "dialog-header",
  DialogPanel: "dialog-panel",
  DialogPopup: "dialog-popup",
  DialogTitle: "dialog-title",
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function TeamControls() {
  const [role, setRole] = useState("No team");
  return (
    <button aria-label="Team profile" onClick={() => setRole("ILM / reviewer")}>
      {role}
    </button>
  );
}

it("lets a hidden team be selected through overflow without changing access", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const changeAccess = vi.fn();
  await act(() => {
    renderer = create(
      <CompactComposerControlsMenu
        interactionMode="default"
        runtimeMode="full-access"
        runtimeModeSupport={undefined}
        runtimeModeOptions={[]}
        showInteractionModeToggle={false}
        teamControls={<TeamControls />}
        onToggleInteractionMode={() => {}}
        onRuntimeModeChange={changeAccess}
      />,
    );
  });
  expect(renderer!.root.findAllByType("dialog" as never)).toHaveLength(0);
  await act(() => renderer!.root.findByType("menu-item" as never).props.onClick());
  const dialog = renderer!.root.findByType("dialog" as never);
  const teamControl = dialog.findByProps({ "aria-label": "Team profile" });
  await act(() => teamControl.props.onClick());
  expect(teamControl.children).toEqual(["ILM / reviewer"]);
  expect(changeAccess).not.toHaveBeenCalled();
  await act(() => dialog.props.onOpenChange(false));
  expect(renderer!.root.findAllByType("dialog" as never)).toHaveLength(0);
});
