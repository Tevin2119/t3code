import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { EllipsisIcon, UsersIcon } from "lucide-react";
import { memo, type ReactNode, useRef, useState } from "react";

import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import type { RuntimeModeSupport } from "./runtimeModeConfig";
import { useComposerMenuState } from "./useComposerMenuState";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  runtimeModeSupport: RuntimeModeSupport;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  teamControls?: ReactNode;
  showPermissions?: boolean;
  size?: "sm" | "xs";
  /** Close the portaled popup when its trigger hides. */
  hidden?: boolean;
  onToggleInteractionMode: () => void;
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
              data-composer-shortcut={
                [
                  props.showPermissions !== false ? "composer.mode" : null,
                  props.traitsMenuContent ? "composer.effort" : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
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
              <MenuDivider />
            </>
          ) : null}
          {props.traitsMenuContent ? (
            <>
              {props.traitsMenuContent}
              {props.showInteractionModeToggle || props.showPermissions !== false ? (
                <MenuDivider />
              ) : null}
            </>
          ) : null}
          {props.showInteractionModeToggle ? (
            <>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
              <MenuRadioGroup
                value={props.interactionMode}
                onValueChange={(value) => {
                  if (!value || value === props.interactionMode) return;
                  props.onToggleInteractionMode();
                }}
              >
                <MenuRadioItem value="default">Chat</MenuRadioItem>
                <MenuRadioItem value="plan">Plan</MenuRadioItem>
              </MenuRadioGroup>
              {props.showPermissions !== false ? <MenuDivider /> : null}
            </>
          ) : null}
          {props.showPermissions === false ? null : (
            <ComposerPermissionsSection
              runtimeMode={props.runtimeMode}
              runtimeModeSupport={props.runtimeModeSupport}
              runtimeModeOptions={props.runtimeModeOptions}
              onRuntimeModeChange={props.onRuntimeModeChange}
            />
          )}
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
