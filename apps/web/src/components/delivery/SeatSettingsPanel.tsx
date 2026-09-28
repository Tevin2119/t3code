import type { SeatSettings } from "../../lib/delivery";
import type { SeatChoice } from "../../state/delivery";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const TEAM_DEFAULT = "__team__";

function Choice(props: {
  readonly label: string;
  readonly value: string | null;
  readonly teamValue: string | null;
  readonly options: ReadonlyArray<string>;
  readonly why: string | null;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  if (props.options.length <= 1 && props.why) {
    return (
      <span className="text-[10px] text-muted-foreground" title={props.why}>
        {props.teamValue ?? "its own"}
      </span>
    );
  }
  return (
    <Select
      value={props.value ?? TEAM_DEFAULT}
      disabled={props.disabled}
      onValueChange={(value) => props.onChange(value === TEAM_DEFAULT ? "" : String(value))}
    >
      <SelectTrigger
        aria-label={props.label}
        size="compact"
        variant="ghost"
        className="w-auto min-w-0"
      >
        <SelectValue>{props.value ?? `${props.teamValue ?? "its own"} (team)`}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        <SelectItem value={TEAM_DEFAULT}>
          As the team defines: {props.teamValue ?? "its own"}
        </SelectItem>
        {props.options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Model, reasoning and access for each seat of a team, for one run. What a
 * harness cannot be told is shown with the reason and cannot be set. What is
 * left alone runs as the team defines it.
 */
export function SeatSettingsPanel(props: {
  readonly settings: ReadonlyArray<SeatSettings>;
  readonly roster: ReadonlyArray<{
    readonly seat: string;
    readonly role: string;
    readonly required: boolean;
  }>;
  readonly chosen: Readonly<Record<string, SeatChoice>>;
  /** Omitted once the workflow has started: the settings are then a record. */
  readonly onChange?: ((seat: string, choice: SeatChoice) => void) | undefined;
}) {
  const locked = props.onChange === undefined;
  return (
    <table className="w-full text-left text-xs" data-delivery-seat-settings>
      <thead className="text-muted-foreground">
        <tr>
          <th className="py-1 pr-2 font-normal">Seat</th>
          <th className="py-1 pr-2 font-normal">Model</th>
          <th className="py-1 pr-2 font-normal">Reasoning</th>
          <th className="py-1 font-normal">Access</th>
        </tr>
      </thead>
      <tbody>
        {props.settings.map((item) => {
          const seat = props.roster.find((candidate) => candidate.seat === item.seat);
          const chosen = props.chosen[item.seat] ?? {};
          const shown = locked ? item.effective : null;
          return (
            <tr key={item.seat} className="border-t border-border align-top" data-seat={item.seat}>
              <td className="py-1 pr-2">
                {item.seat}
                <span className="block text-[10px] text-muted-foreground">
                  {seat?.role ?? ""} on {item.harness}
                </span>
              </td>
              <td className="py-1 pr-2">
                {shown ? (
                  <span className="font-mono text-[10px]">{shown.model ?? "its own"}</span>
                ) : item.may.model ? (
                  <Input
                    aria-label={`Model for ${item.seat}`}
                    size="sm"
                    className="h-7 w-44 font-mono text-[11px]"
                    placeholder={item.now.model ?? "the harness's own"}
                    value={chosen.model ?? ""}
                    onChange={(event) =>
                      props.onChange?.(item.seat, { model: event.target.value.trim() })
                    }
                  />
                ) : (
                  <span className="text-[10px] text-muted-foreground" title={item.why.model ?? ""}>
                    {item.now.model ?? "its own"}
                  </span>
                )}
              </td>
              <td className="py-1 pr-2">
                {shown ? (
                  <span className="font-mono text-[10px]">{shown.reasoning ?? "its own"}</span>
                ) : (
                  <Choice
                    label={`Reasoning for ${item.seat}`}
                    value={chosen.reasoning ?? null}
                    teamValue={item.now.reasoning}
                    options={item.may.reasoning}
                    why={
                      item.may.reasoning.length === 0
                        ? (item.why.reasoning ?? "cannot be set")
                        : null
                    }
                    disabled={locked}
                    onChange={(value) => props.onChange?.(item.seat, { reasoning: value })}
                  />
                )}
              </td>
              <td className="py-1">
                {shown ? (
                  <span className="font-mono text-[10px]">{shown.access ?? "full"}</span>
                ) : (
                  <Choice
                    label={`Access for ${item.seat}`}
                    value={chosen.access ?? null}
                    teamValue={item.now.access}
                    options={item.may.access}
                    why={item.may.access.length <= 1 ? (item.why.access ?? "cannot be set") : null}
                    disabled={locked}
                    onChange={(value) => props.onChange?.(item.seat, { access: value })}
                  />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
