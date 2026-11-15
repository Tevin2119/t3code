import type { RuntimeMode } from "@t3tools/contracts";
import { EllipsisIcon, UsersIcon } from "lucide-react";
import { memo, type ReactNode, useRef, useState } from "react";

import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator as MenuDivider, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import type { RuntimeModeSupport } from "./runtimeModeConfig";
import { useComposerMenuState } from "./useComposerMenuState";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  runtimeMode: RuntimeMode;
  runtimeModeSupport: RuntimeModeSupport;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  teamControls?: ReactNode;
  showPermissions: boolean;
  size?: "sm" | "xs";
  /** Close the portaled popup when its trigger hides. */
  hidden?: boolean;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const [teamOpen, setTeamOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (teamOpen && !props.teamControls) setTeamOpen(false);

  return (
    <>
      <Menu
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, triggerRef.current)}
      >
        <MenuTrigger
          render={
            <ComposerControl
              ref={triggerRef}
              size={size}
              className="shrink-0"
              aria-label="More composer controls"
              data-composer-shortcut={props.showPermissions ? "composer.mode" : undefined}
            />
          }
        >
          <ComposerControlIcon icon={EllipsisIcon} size={size} />
        </MenuTrigger>
        <MenuPopup align="start" {...composerFloatingLayerProps}>
          {props.teamControls ? (
            <>
              <MenuItem onClick={() => setTeamOpen(true)}>
                <UsersIcon />
                Team profile and role
              </MenuItem>
              {props.showPermissions ? <MenuDivider /> : null}
            </>
          ) : null}
          {props.showPermissions ? (
            <ComposerPermissionsSection
              runtimeMode={props.runtimeMode}
              runtimeModeSupport={props.runtimeModeSupport}
              runtimeModeOptions={props.runtimeModeOptions}
              onRuntimeModeChange={props.onRuntimeModeChange}
            />
          ) : null}
        </MenuPopup>
      </Menu>
      {teamOpen && props.teamControls ? (
        <Dialog open onOpenChange={setTeamOpen}>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Team profile and role</DialogTitle>
            </DialogHeader>
            <DialogPanel className="overflow-x-auto">{props.teamControls}</DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
});
