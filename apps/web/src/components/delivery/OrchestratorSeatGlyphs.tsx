import { ProviderDriverKind } from "@t3tools/contracts";
import { EyeIcon, type LucideIcon } from "lucide-react";
import type { KeyboardEvent, ReactElement } from "react";

import { cn } from "~/lib/utils";
import zaiLogo from "../../assets/zai-logo.svg";
import type { OrchestratorParticipantAccess } from "../../lib/orchestratorChat";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { ProviderInstanceIcon, providerTextColor } from "../chat/ProviderInstanceIcon";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** What a participant may do, with the composer's own glyphs for the two modes it shares. */
export const ACCESS_LEVELS: ReadonlyArray<{
  readonly value: OrchestratorParticipantAccess;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { value: "read-only", label: "Read-only", icon: EyeIcon },
  {
    value: "approval-required",
    label: "Ask me before changes",
    icon: runtimeModeConfig["approval-required"].icon,
  },
  { value: "full-access", label: "Full access", icon: runtimeModeConfig["full-access"].icon },
];

export const accessLevel = (value: OrchestratorParticipantAccess) =>
  ACCESS_LEVELS.find((level) => level.value === value) ?? ACCESS_LEVELS[0]!;

/** A model family T3 already has a logo for: a provider's own, or the Z.AI mark for GLM. */
type ModelFamily =
  | { readonly id: string; readonly driver: ProviderDriverKind }
  | { readonly id: string; readonly logo: string };

// Only families whose logo T3 already has; any other model is named in text alone.
const MODEL_FAMILIES: ReadonlyArray<readonly [RegExp, ModelFamily]> = (
  [
    ["claudeAgent", /\bclaude\b/i],
    ["codex", /\bgpt\b/i],
    ["antigravity", /\bgemini\b/i],
    ["grok", /\bgrok\b/i],
    ["kimi", /\bkimi\b/i],
    ["deepseek", /\bdeepseek\b/i],
  ] as const
).map(([driver, pattern]): readonly [RegExp, ModelFamily] => [
  pattern,
  { id: driver, driver: ProviderDriverKind.make(driver) },
]);
const GLM_FAMILY: readonly [RegExp, ModelFamily] = [
  /\b(glm|zai|z\.ai|zhipu)/i,
  { id: "glm", logo: zaiLogo },
];

/** The logo that names this model's family, when that is not the harness's own. */
export function modelFamily(
  harness: ProviderDriverKind,
  model: { readonly slug: string; readonly name: string },
): ModelFamily | null {
  const text = `${model.name} ${model.slug}`;
  const family = [...MODEL_FAMILIES, GLM_FAMILY].find(([pattern]) => pattern.test(text))?.[1];
  return family && family.id !== harness ? family : null;
}

/** A seat's harness logo, with its model's family in the corner when that is another one. */
export function HarnessTile(props: {
  readonly entry: ProviderInstanceEntry | null;
  readonly model: { readonly slug: string; readonly name: string } | null;
}) {
  const { entry } = props;
  if (!entry) {
    return (
      <span
        aria-hidden
        className="size-7.5 shrink-0 rounded-lg border border-dashed border-input"
      />
    );
  }
  const tone = providerTextColor(entry.driverKind);
  const family = props.model ? modelFamily(entry.driverKind, props.model) : null;
  const familyTone = family && "driver" in family ? providerTextColor(family.driver) : null;
  return (
    // The line beside the tile names the harness and the model in words.
    <span
      aria-hidden
      data-orchestrator-seat-harness={entry.driverKind}
      className={cn(
        "relative flex size-7.5 shrink-0 items-center justify-center rounded-lg bg-secondary",
        tone.className,
      )}
      style={tone.style}
    >
      <ProviderInstanceIcon
        driverKind={entry.driverKind}
        displayName={entry.displayName}
        accentColor={entry.accentColor}
        acpRegistryAgentId={entry.acpRegistryAgentId}
        acpRegistryIconUrl={entry.acpRegistryIconUrl}
        className="size-4.5"
        iconClassName="size-4.5"
      />
      {family ? (
        <span
          data-orchestrator-seat-model-family={family.id}
          className={cn(
            "absolute -right-1 -bottom-1 z-40 flex size-4 items-center justify-center rounded-full border border-border bg-popover",
            familyTone?.className,
          )}
          style={familyTone?.style}
        >
          {"driver" in family ? (
            <ProviderInstanceIcon
              driverKind={family.driver}
              displayName=""
              className="size-2.5"
              iconClassName="size-2.5"
            />
          ) : (
            <img src={family.logo} alt="" className="size-2.5 object-contain" />
          )}
        </span>
      ) : null}
    </span>
  );
}

/** An icon-only button that keeps its words: an accessible name and a tooltip. */
export function GlyphButton(props: {
  readonly label: string;
  readonly render: ReactElement;
  readonly children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.render}>{props.children}</TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

const moveRadioFocus = (event: KeyboardEvent<HTMLDivElement>) => {
  const step =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
  if (step === 0) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  const next =
    radios[(radios.indexOf(event.target as HTMLElement) + step + radios.length) % radios.length];
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.click();
};

/**
 * One participant's access as glyphs: a segmented radio group, and on a narrow panel a single
 * glyph that opens the same choices.
 */
export function AccessGlyphs(props: {
  /** Names the control, such as "Access of Scout". */
  readonly label: string;
  readonly value: OrchestratorParticipantAccess;
  readonly onChange: (access: OrchestratorParticipantAccess) => void;
  readonly disabled?: boolean | undefined;
}) {
  const current = accessLevel(props.value);
  const CurrentIcon = current.icon;
  return (
    <>
      <div
        role="radiogroup"
        aria-label={props.label}
        data-orchestrator-access={props.value}
        className="flex shrink-0 gap-px rounded-lg bg-input/40 p-0.5 @max-[23rem]/lineup:hidden"
        onKeyDown={moveRadioFocus}
      >
        {ACCESS_LEVELS.map((level) => {
          const chosen = level.value === props.value;
          const Icon = level.icon;
          return (
            <GlyphButton
              key={level.value}
              label={level.label}
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  aria-label={level.label}
                  tabIndex={chosen ? 0 : -1}
                  disabled={props.disabled}
                  onClick={() => props.onChange(level.value)}
                  className={cn(
                    "relative flex h-6 w-6 cursor-pointer disabled:cursor-default items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:w-8 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11",
                    chosen && "bg-background text-foreground shadow-xs/10 dark:bg-input/72",
                    chosen && level.value === "full-access" && "text-warning hover:text-warning",
                  )}
                />
              }
            >
              <Icon aria-hidden className="size-3.5" />
            </GlyphButton>
          );
        })}
      </div>
      <span className="hidden shrink-0 @max-[23rem]/lineup:flex">
        <Menu>
          <GlyphButton
            label={`${props.label}: ${current.label}`}
            render={
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="secondary"
                    aria-label={props.label}
                    disabled={props.disabled}
                  />
                }
              />
            }
          >
            <CurrentIcon
              aria-hidden
              className={cn("size-3.5", props.value === "full-access" && "text-warning")}
            />
          </GlyphButton>
          <MenuPopup align="end">
            <MenuRadioGroup
              value={props.value}
              onValueChange={(next) => {
                const level = ACCESS_LEVELS.find((item) => item.value === next);
                if (level) props.onChange(level.value);
              }}
            >
              {ACCESS_LEVELS.map((level) => {
                const Icon = level.icon;
                return (
                  <MenuRadioItem key={level.value} value={level.value}>
                    <span className="flex items-center gap-2">
                      <Icon aria-hidden className="size-3.5" />
                      {level.label}
                    </span>
                  </MenuRadioItem>
                );
              })}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      </span>
    </>
  );
}
