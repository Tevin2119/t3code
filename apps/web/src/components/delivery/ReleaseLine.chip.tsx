import {
  CircleCheckIcon,
  CircleDashedIcon,
  ClockIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { InstanceTone } from "./ReleaseLine.logic";

// The v2 sidebar update pills' tones (SidebarCheckoutUpdatePill), so an instance reads the same.
const CHIP_TONES: Record<InstanceTone, string> = {
  live: "bg-sidebar-control-surface text-sidebar-foreground",
  waiting: "bg-sidebar-control-surface text-sidebar-foreground",
  unknown: "bg-sidebar-control-surface text-sidebar-foreground",
  busy: "bg-sidebar-control-surface text-sidebar-foreground",
  problem: "bg-destructive/12 text-destructive",
};
const CHIP_ICONS = {
  live: CircleCheckIcon,
  waiting: ClockIcon,
  unknown: CircleDashedIcon,
  busy: RefreshCwIcon,
  problem: TriangleAlertIcon,
} as const;

/** An instance's or a promotion's state, in the v2 sidebar update-pill look. */
export function InstanceChip({ tone, label }: { tone: InstanceTone; label: string }) {
  const Icon = CHIP_ICONS[tone];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-0.5 text-2xs leading-4 font-medium ${CHIP_TONES[tone]}`}
      data-instance-state={tone}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}
