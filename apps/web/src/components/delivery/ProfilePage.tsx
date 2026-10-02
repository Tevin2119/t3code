import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CopyIcon,
  HistoryIcon,
  PlusIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import {
  parseFlows,
  parseProfile,
  parseProfiles,
  SEAT_DUTIES,
  SEAT_DUTY_LABEL,
  type ProfileForm,
  type ProfileSeat,
  type ProfileSummary,
  type ProfileView,
} from "../../lib/delivery";
import { entryForHarness, harnessLabel, harnessOfDriver } from "../../lib/deliverySeats";
import { cn } from "../../lib/utils";
import {
  useDeliveryAct,
  useDeliveryEnabled,
  useDeliveryRead,
  usePersonName,
} from "../../state/delivery";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useSeatCatalog } from "./SeatSettingsPanel";
import { SetupPanel } from "./SetupPanel";
import { TeamDefaultsDialog } from "./TeamDefaultsDialog";
import { TrackRecord } from "./TrackRecord";

const NONE = "__none__";
const FLOW_TITLE: Readonly<Record<string, string>> = {
  chat: "Team chat",
  plan: "Plan",
  review: "Review",
  standard: "Standard delivery",
};

function Field(props: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium">{props.label}</span>
      {props.children}
      {props.hint ? <span className="text-[11px] text-muted-foreground">{props.hint}</span> : null}
    </label>
  );
}

const NEW_SEAT: ProfileSeat = {
  id: "",
  title: "",
  role: "",
  instructions: "",
  active: true,
  harness: "claude",
  model: null,
  reasoning: null,
  access: null,
  required: false,
  focus: "",
  duties: ["plan"],
};

function SeatEditor(props: {
  readonly environmentId: EnvironmentId | null;
  readonly seat: ProfileSeat;
  readonly view: ProfileView;
  readonly isLead: boolean;
  readonly locked: boolean;
  readonly onChange: (seat: ProfileSeat) => void;
  readonly onLead: () => void;
  readonly onRemove: (() => void) | null;
}) {
  const { seat, view, locked } = props;
  const catalog = useSeatCatalog(props.environmentId);
  const entry = entryForHarness(catalog.entries, seat.harness);
  const takes = view.harnesses[seat.harness] ?? { model: false, reasoning: [], access: [] };
  const set = (patch: Partial<ProfileSeat>) => props.onChange({ ...seat, ...patch });
  const name = seat.title || seat.id || "this seat";

  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border p-2",
        !seat.active && "opacity-70",
      )}
      data-profile-seat={seat.id || seat.title}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          aria-label={`${name} takes part`}
          checked={seat.active}
          disabled={locked}
          onCheckedChange={(next) => set({ active: next })}
        />
        <Input
          aria-label="Name of the seat"
          placeholder="Name of the seat"
          className="h-7 w-48 text-xs"
          value={seat.title}
          disabled={locked}
          onChange={(event) => set({ title: event.target.value })}
        />
        {locked ? (
          <span className="text-xs" data-profile-seat-runs-on>
            {harnessLabel(seat.harness)}, {seat.model ?? "its own model"}
          </span>
        ) : entry ? (
          <ProviderModelPicker
            activeInstanceId={entry.instanceId}
            model={seat.model ?? ""}
            lockedProvider={null}
            instanceEntries={catalog.entries}
            modelOptionsByInstance={catalog.options}
            size="xs"
            triggerVariant="outline"
            triggerAriaLabel={`Harness and model for ${name}`}
            {...(takes.model
              ? {}
              : { triggerLabel: `${harnessLabel(seat.harness)}, its own model` })}
            onInstanceModelChange={(instanceId, model) => {
              const picked = catalog.entries.find((item) => item.instanceId === instanceId);
              const harness = picked ? harnessOfDriver(picked.driverKind) : null;
              if (!harness) return;
              const next = view.harnesses[harness] ?? { model: false, reasoning: [], access: [] };
              set({
                harness,
                model: next.model ? model : null,
                // What the harness it left took means nothing to the one it moved to.
                reasoning:
                  seat.reasoning && next.reasoning.includes(seat.reasoning) ? seat.reasoning : null,
                access: seat.access && next.access.includes(seat.access) ? seat.access : null,
              });
            }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            {harnessLabel(seat.harness)}, which is not set up in T3 Code here
          </span>
        )}
        {takes.reasoning.length > 0 ? (
          <Select
            value={seat.reasoning ?? NONE}
            disabled={locked}
            onValueChange={(value) => set({ reasoning: value === NONE ? null : String(value) })}
          >
            <SelectTrigger
              aria-label={`Reasoning for ${name}`}
              size="compact"
              variant="ghost"
              className="w-auto"
            >
              <SelectValue>{seat.reasoning ?? "Reasoning: its own"}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem value={NONE}>The harness's own</SelectItem>
              {takes.reasoning.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        {takes.access.length > 1 ? (
          <Select
            value={seat.access ?? takes.access[0] ?? NONE}
            disabled={locked}
            onValueChange={(value) => set({ access: String(value) })}
          >
            <SelectTrigger
              aria-label={`Access for ${name}`}
              size="compact"
              variant="ghost"
              className="w-auto"
            >
              <SelectValue>{seat.access ?? takes.access[0]} access</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {takes.access.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        {props.onRemove && !locked ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="ml-auto"
                  aria-label={`Remove ${name}`}
                  onClick={props.onRemove}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Remove this seat from the profile</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="profile-lead"
            checked={props.isLead}
            disabled={locked}
            onChange={props.onLead}
          />
          Leads
        </label>
        {SEAT_DUTIES.map((duty) => (
          <label key={duty} className="flex items-center gap-1">
            <Checkbox
              checked={seat.duties.includes(duty)}
              disabled={locked}
              onCheckedChange={(next) =>
                set({
                  duties: next
                    ? [...seat.duties.filter((item) => item !== duty), duty]
                    : seat.duties.filter((item) => item !== duty),
                })
              }
            />
            {SEAT_DUTY_LABEL[duty]}
          </label>
        ))}
        <label className="flex items-center gap-1">
          <Checkbox
            checked={seat.required}
            disabled={locked}
            onCheckedChange={(next) => set({ required: next === true })}
          />
          Work stops without it
        </label>
      </div>
      <Textarea
        aria-label={`Instructions for ${name}`}
        placeholder="What this seat is there for, in the words it is to be given"
        className="min-h-20 text-xs"
        value={seat.instructions}
        disabled={locked}
        onChange={(event) => set({ instructions: event.target.value })}
      />
    </section>
  );
}

/** Asks before removing a profile of one's own, and says what becomes of it. */
function RemoveProfileDialog(props: {
  readonly environmentId: EnvironmentId | null;
  readonly profile: string;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const person = usePersonName();
  const act = useDeliveryAct(props.environmentId, "remove profile");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setProblem(null);
    const result = await act(`/api/profiles/${props.profile}/remove`, { by: person });
    setBusy(false);
    if (!result.ok) {
      setProblem(result.why);
      return;
    }
    props.onRemoved();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup className="max-w-md" data-profile-remove-confirm>
        <DialogHeader>
          <DialogTitle>Remove {props.profile}?</DialogTitle>
          <DialogDescription>
            It can no longer be chosen for a task or a conversation. Its files are moved to the
            engine's history, not deleted. A profile with work under way or tasks still open is not
            removed; the engine says which.
          </DialogDescription>
        </DialogHeader>
        {problem ? (
          <DialogPanel>
            <p className="text-xs text-warning" data-delivery-problem>
              {problem}
            </p>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Keep it
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing" : "Remove the profile"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ProfileList(props: {
  readonly profiles: ReadonlyArray<ProfileSummary>;
  readonly onOpen: (name: string) => void;
  readonly onRemove: (name: string) => void;
}) {
  return (
    <ul className="grid gap-2 p-5 md:grid-cols-2 xl:grid-cols-3" data-profile-list>
      {props.profiles.map((item) => (
        <li key={item.profile} className="relative">
          {item.source === "custom" ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="absolute top-2 right-2 z-10"
              aria-label={`Remove ${item.profile}`}
              onClick={() => props.onRemove(item.profile)}
              data-profile-card-remove={item.profile}
            >
              <Trash2Icon />
            </Button>
          ) : null}
          <button
            type="button"
            onClick={() => props.onOpen(item.profile)}
            data-profile-card={item.profile}
            className="flex h-full w-full cursor-pointer flex-col gap-1 rounded-lg border border-border p-3 text-left text-xs hover:bg-accent"
          >
            <span
              className={cn(
                "flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium break-all",
                // Room for the bin beside it, so a long name is never under it.
                item.source === "custom" && "pr-7",
              )}
            >
              {item.profile}
              <Badge size="sm" variant={item.source === "custom" ? "secondary" : "outline"}>
                {item.source === "custom" ? "yours" : "comes with the engine"}
              </Badge>
            </span>
            <span className="text-muted-foreground">
              {item.purpose || "No purpose written yet."}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {item.seatsOn} of {item.seats} seats on. Flows:{" "}
              {item.flows.map((flow) => FLOW_TITLE[flow] ?? flow).join(", ") || "none"}. Revision{" "}
              {item.revision}.
            </span>
            {item.problem ? <span className="text-warning">{item.problem}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function NewProfile(props: {
  readonly environmentId: EnvironmentId | null;
  readonly from: string | null;
  readonly onMade: (name: string) => void;
}) {
  const person = usePersonName();
  const act = useDeliveryAct(props.environmentId, "new profile");
  const [name, setName] = useState(props.from ? `my-${props.from}` : "");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const make = async () => {
    setBusy(true);
    setProblems([]);
    const result = await act("/api/profiles", { name, from: props.from, by: person });
    setBusy(false);
    if (!result.ok) {
      setProblems(result.problems.length > 0 ? result.problems : [result.why]);
      return;
    }
    const made = parseProfile(result.body);
    if (made) props.onMade(made.form.name);
  };
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 p-5" data-profile-new-form>
      <p className="text-sm text-muted-foreground">
        {props.from
          ? `A copy of ${props.from} that is yours to change: its core prompt, its seats and what they run on, its tools and its flows.`
          : "A blank profile: one seat, a core prompt to write, and nothing else. You add the seats, pick a harness and a model for each, and say what the team is for."}
      </p>
      <Field
        label="Name"
        hint="Small letters, digits and hyphens. It names the folder its files are kept in."
      >
        <Input
          aria-label="Name of the profile"
          placeholder="research-duo"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim()) void make();
          }}
        />
      </Field>
      {problems.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-warning" data-delivery-problem>
          {problems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <Button disabled={busy || !name.trim()} onClick={() => void make()} data-profile-make>
          {props.from ? "Duplicate" : "Make the profile"}
        </Button>
      </div>
    </div>
  );
}

function ProfileEditor(props: {
  readonly environmentId: EnvironmentId | null;
  readonly view: ProfileView;
  readonly onSaved: () => void;
  readonly onRemoved: () => void;
  readonly onDuplicate: () => void;
}) {
  const { view } = props;
  const person = usePersonName();
  const act = useDeliveryAct(props.environmentId, "profile");
  const [form, setForm] = useState<ProfileForm>(view.form);
  // What is saved is what the form shows, until a person changes something.
  const [loaded, setLoaded] = useState(`${view.profile}@${view.revision}`);
  if (loaded !== `${view.profile}@${view.revision}`) {
    setLoaded(`${view.profile}@${view.revision}`);
    setForm(view.form);
  }
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const [said, setSaid] = useState<string | null>(null);
  const [section, setSection] = useState<"profile" | "setup">("profile");
  const [removing, setRemoving] = useState(false);
  const locked = !view.editable;
  const changed = JSON.stringify(form) !== JSON.stringify(view.form);
  const set = (patch: Partial<ProfileForm>) => setForm((current) => ({ ...current, ...patch }));
  const setSeat = (index: number, seat: ProfileSeat) =>
    set({ seats: form.seats.map((item, at) => (at === index ? seat : item)) });
  const flows = useMemo(
    () =>
      parseFlows(
        ["chat", "plan", "review", "standard"].map((id) => ({ id, title: FLOW_TITLE[id] })),
      ),
    [],
  );

  const save = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setProblems([]);
    setSaid(null);
    const result = await act(`/api/profiles/${view.profile}`, {
      ...form,
      by: person,
      note: note.trim() || null,
    });
    working.current = false;
    setBusy(false);
    if (!result.ok) {
      setProblems(result.problems.length > 0 ? result.problems : [result.why]);
      return;
    }
    setSaid(parseProfile(result.body)?.note ?? "Saved.");
    setNote("");
    props.onSaved();
  };

  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-5"
      data-profile-editor={view.profile}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">{view.profile}</h2>
        <Badge size="sm" variant={locked ? "outline" : "secondary"}>
          {locked ? "comes with the engine" : "yours"}
        </Badge>
        <span className="font-mono text-[10px] text-muted-foreground">{view.configuration}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant={section === "profile" ? "secondary" : "ghost"}
            onClick={() => setSection("profile")}
          >
            Profile
          </Button>
          <Button
            size="xs"
            variant={section === "setup" ? "secondary" : "ghost"}
            onClick={() => setSection("setup")}
            data-profile-setup
          >
            What each seat is given
          </Button>
          <Button size="xs" variant="outline" onClick={props.onDuplicate}>
            <CopyIcon />
            Duplicate
          </Button>
          {locked ? null : (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => setRemoving(true)}
              data-profile-remove
            >
              <Trash2Icon />
              Remove
            </Button>
          )}
        </div>
      </div>
      {removing ? (
        <RemoveProfileDialog
          environmentId={props.environmentId}
          profile={view.profile}
          onClose={() => setRemoving(false)}
          onRemoved={() => {
            setRemoving(false);
            props.onRemoved();
          }}
        />
      ) : null}
      {locked ? (
        <p className="text-xs text-muted-foreground" data-profile-locked>
          This team comes with the engine and is changed in the repository. Duplicate it to have one
          of your own. What its seats run on by default can be set under Team defaults.
        </p>
      ) : null}
      {view.problem ? (
        <p className="text-sm text-warning" data-profile-problem>
          The files of this profile could not be read: {view.problem}. The revision shown here is
          the last one that could be read, and is the one in use.
        </p>
      ) : null}

      {section === "setup" ? (
        <SetupPanel environmentId={props.environmentId} team={view.profile} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex min-w-0 flex-col gap-4">
              <Field label="Purpose" hint="One or two sentences. Shown where a team is chosen.">
                <Input
                  aria-label="Purpose"
                  value={form.purpose}
                  disabled={locked}
                  onChange={(event) => set({ purpose: event.target.value })}
                />
              </Field>
              <Field
                label="Core prompt"
                hint="Given to every seat, in every conversation and every piece of work of this profile, before the seat's own instructions. What the project itself is about comes from the repository's own AGENTS.md, which every harness reads by itself."
              >
                <Textarea
                  aria-label="Core prompt"
                  className="min-h-48 font-mono text-xs"
                  value={form.corePrompt}
                  disabled={locked}
                  onChange={(event) => set({ corePrompt: event.target.value })}
                />
              </Field>
            </div>
            <aside className="flex min-w-0 flex-col gap-4">
              <Field label="Default flow" hint="What this team does when no flow is chosen.">
                <Select
                  value={form.defaultFlow}
                  disabled={locked}
                  onValueChange={(value) => set({ defaultFlow: String(value) })}
                >
                  <SelectTrigger aria-label="Default flow" size="compact">
                    <SelectValue>{FLOW_TITLE[form.defaultFlow] ?? form.defaultFlow}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {flows.map((flow) => (
                      <SelectItem key={flow.id} value={flow.id}>
                        {flow.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field label="What is kept" hint={view.memoryScopes[form.memory.scope]}>
                <Select
                  value={form.memory.scope}
                  disabled={locked}
                  onValueChange={(value) =>
                    set({ memory: { ...form.memory, scope: String(value) } })
                  }
                >
                  <SelectTrigger aria-label="What is kept" size="compact">
                    <SelectValue>
                      {form.memory.scope === "profile"
                        ? "Notes of the profile"
                        : "Nothing between conversations"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    <SelectItem value="conversation">Nothing between conversations</SelectItem>
                    <SelectItem value="profile">Notes of the profile</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
              {form.memory.scope === "profile" ? (
                <Field
                  label="Notes"
                  hint="Written by you. Given to every seat after the core prompt."
                >
                  <Textarea
                    aria-label="Notes of the profile"
                    className="min-h-24 text-xs"
                    value={form.memory.notes}
                    disabled={locked}
                    onChange={(event) =>
                      set({ memory: { ...form.memory, notes: event.target.value } })
                    }
                  />
                </Field>
              ) : null}
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-medium">Tools</h3>
                {view.toolsOffered.map((tool) => (
                  <label key={tool.server} className="flex items-start gap-1.5 text-xs">
                    <Checkbox
                      checked={form.tools.includes(tool.server)}
                      disabled={locked}
                      onCheckedChange={(next) =>
                        set({
                          tools: next
                            ? [...form.tools.filter((item) => item !== tool.server), tool.server]
                            : form.tools.filter((item) => item !== tool.server),
                        })
                      }
                    />
                    <span>
                      {tool.server}
                      <span className="block text-[11px] text-muted-foreground">
                        {tool.offers.join(", ")}
                        {tool.onlyFor ? `. Only for ${tool.onlyFor}` : ""}
                      </span>
                    </span>
                  </label>
                ))}
                <p className="text-[11px] text-muted-foreground">
                  Whether a tool works for a seat is shown under "What each seat is given", after it
                  was checked.
                </p>
              </section>
            </aside>
          </div>

          <section className="flex flex-col gap-2" data-profile-seats>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">Seats</h3>
              <span className="text-[11px] text-muted-foreground">
                {form.seats.filter((seat) => seat.active).length} of {form.seats.length} switched on
              </span>
              {locked ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => set({ seats: [...form.seats, NEW_SEAT] })}
                  data-profile-add-seat
                >
                  <PlusIcon />
                  Add a seat
                </Button>
              )}
            </div>
            {form.seats.map((seat, index) => (
              <SeatEditor
                // A new seat has no id until it is saved, so its place stands in for one.
                key={seat.id || `new-${index}`}
                environmentId={props.environmentId}
                seat={seat}
                view={view}
                locked={locked}
                isLead={(form.lead || form.seats[0]?.id) === (seat.id || seat.title)}
                onLead={() => set({ lead: seat.id || seat.title })}
                onChange={(next) => setSeat(index, next)}
                onRemove={
                  form.seats.length > 1
                    ? () => set({ seats: form.seats.filter((_item, at) => at !== index) })
                    : null
                }
              />
            ))}
            <p className="text-[11px] text-muted-foreground">
              A delivery needs a seat that leads, one that builds, one that reviews, and seats that
              test on {form.qaMinimum} providers that did not build. A chat, a plan and a review
              need less. The engine says what is missing when a flow cannot run.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">Specialists</h3>
              {locked ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  onClick={() =>
                    set({ specialists: [...form.specialists, { name: "", text: "" }] })
                  }
                >
                  <PlusIcon />
                  Add a specialist
                </Button>
              )}
            </div>
            {form.specialists.length === 0 ? (
              <p className="text-xs text-muted-foreground">None.</p>
            ) : null}
            {form.specialists.map((item, index) => (
              // Specialists are told apart by their place while they are edited.
              // oxlint-disable-next-line react/no-array-index-key
              <div key={index} className="flex flex-col gap-1 rounded-md border border-border p-2">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Name of the specialist"
                    placeholder="Name"
                    className="h-7 w-56 text-xs"
                    value={item.name}
                    disabled={locked}
                    onChange={(event) =>
                      set({
                        specialists: form.specialists.map((other, at) =>
                          at === index ? { ...other, name: event.target.value } : other,
                        ),
                      })
                    }
                  />
                  {locked ? null : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="ml-auto"
                      aria-label={`Remove the specialist ${item.name}`}
                      onClick={() =>
                        set({ specialists: form.specialists.filter((_other, at) => at !== index) })
                      }
                    >
                      <XIcon />
                    </Button>
                  )}
                </div>
                <Textarea
                  aria-label={`Instructions for the specialist ${item.name}`}
                  className="min-h-20 font-mono text-xs"
                  value={item.text}
                  disabled={locked}
                  onChange={(event) =>
                    set({
                      specialists: form.specialists.map((other, at) =>
                        at === index ? { ...other, text: event.target.value } : other,
                      ),
                    })
                  }
                />
              </div>
            ))}
          </section>

          <section className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">Reference files</h3>
            <ul className="flex flex-col gap-0.5 text-xs">
              {form.references.map((file) => (
                <li key={file} className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file}</span>
                  {locked ? null : (
                    <button
                      type="button"
                      aria-label={`Remove ${file}`}
                      className="cursor-pointer text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        set({ references: form.references.filter((item) => item !== file) })
                      }
                    >
                      <XIcon className="size-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {locked ? null : (
              <Input
                aria-label="Add a reference file"
                placeholder="Full path of a file on the engine's host, then Enter"
                className="h-7 font-mono text-xs"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || !reference.trim()) return;
                  set({
                    references: [
                      ...form.references.filter((item) => item !== reference.trim()),
                      reference.trim(),
                    ],
                  });
                  setReference("");
                }}
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              Every seat is told where these files are, and is given the short ones in full.
            </p>
          </section>

          {problems.length > 0 ? (
            <ul className="list-disc pl-5 text-sm text-warning" data-delivery-problem>
              {problems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          {said ? (
            <p className="text-xs text-muted-foreground" data-profile-said>
              {said}
            </p>
          ) : null}

          {locked ? null : (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Input
                aria-label="Why the profile is changed"
                placeholder="Why it is changed (kept with the revision)"
                className="h-8 max-w-md text-xs"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <Button disabled={busy || !changed} onClick={() => void save()} data-profile-save>
                {busy ? "Saving" : changed ? `Save as revision ${view.revision + 1}` : "Saved"}
              </Button>
            </div>
          )}

          <section className="flex flex-col gap-1 text-xs">
            <h3 className="font-medium text-muted-foreground">Files and revisions</h3>
            <p className="font-mono text-[11px] break-all" data-profile-folder>
              {view.folder}
            </p>
            <p className="text-[11px] text-muted-foreground">
              These are the files the form writes: team.json, TEAM.md for the core prompt, a file
              for each role under roles, and the tools under tools.{" "}
              {locked
                ? ""
                : "They can be edited by hand. Press Reload to have them read again. A file that cannot be read leaves the last good revision in use, and what is wrong is said here."}
            </p>
            <ul className="flex flex-col gap-0.5">
              {view.history.map((entry) => (
                <li key={entry.revision} className="font-mono text-[10px] text-muted-foreground">
                  r{entry.revision}, {entry.by}, {entry.at}
                  {entry.note ? `: ${entry.note}` : ""}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Profiles: the teams that come with the engine, and the ones a person made.
 * A profile holds what a team is for, the words every seat is given, its
 * seats and what they run on, its tools, and the flow it runs by default.
 */
export function ProfilePage() {
  const environmentId = usePrimaryEnvironmentId();
  const enabled = useDeliveryEnabled(environmentId);
  const active = enabled ? environmentId : null;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { name?: string; new?: boolean; from?: string };
  const act = useDeliveryAct(active, "profiles");
  const listRead = useDeliveryRead(active, "/api/profiles");
  const profiles = useMemo(() => parseProfiles(listRead.body), [listRead.body]);
  const oneRead = useDeliveryRead(active, search.name ? `/api/profiles/${search.name}` : null);
  const view = useMemo(() => parseProfile(oneRead.body), [oneRead.body]);
  const [reloaded, setReloaded] = useState<string | null>(null);
  const [opened, setOpened] = useState<"triage" | "record" | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const go = (next: { name?: string; new?: boolean; from?: string }) =>
    void navigate({ to: "/profiles", search: next });

  const reload = async () => {
    const result = await act("/api/profiles/reload", {});
    listRead.refresh();
    oneRead.refresh();
    if (!result.ok) {
      setReloaded(result.why);
      return;
    }
    const body = result.body as {
      loaded?: string[];
      kept?: string[];
      failed?: Array<{ profile: string; why: string; inUse: string }>;
    };
    setReloaded(
      [
        `Read again: ${(body.loaded ?? []).join(", ") || "nothing had changed"}.`,
        ...(body.failed ?? []).map(
          (item) => `${item.profile} could not be read: ${item.why}. In use: ${item.inUse}.`,
        ),
      ].join(" "),
    );
  };

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-profile-page>
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 py-2">
            {search.name || search.new ? (
              <Button size="xs" variant="ghost" onClick={() => go({})}>
                <ArrowLeftIcon />
                Profiles
              </Button>
            ) : (
              <h1 className="text-sm font-medium">Profiles</h1>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!enabled}
                      onClick={() => setOpened("triage")}
                      data-profile-triage
                    />
                  }
                >
                  <SlidersHorizontalIcon />
                  Triage
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  What triage runs on: the seats that sort each new task before a team takes it.
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!enabled}
                      onClick={() => setOpened("record")}
                      data-profile-record
                    />
                  }
                >
                  <HistoryIcon />
                  Track record
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  How each harness and model has done in each team and stage on this host.
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!enabled}
                      onClick={() => void reload()}
                      data-profile-reload
                    />
                  }
                >
                  <RefreshCwIcon />
                  Reload
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  Read the files of every profile again, after they were edited by hand.
                </TooltipPopup>
              </Tooltip>
              <Button
                size="xs"
                disabled={!enabled}
                onClick={() => go({ new: true })}
                data-profile-new
              >
                <PlusIcon />
                New profile
              </Button>
            </div>
          </div>
        </WorkspacePageHeader>
        {!enabled ? (
          <p className="p-6 text-sm text-muted-foreground">
            Delivery is turned off for this environment.
          </p>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            {listRead.error ? (
              <p className="px-5 pt-3 text-sm text-warning">
                Delivery engine not reachable. {listRead.error}
              </p>
            ) : null}
            {reloaded ? (
              <p className="px-5 pt-3 text-xs text-muted-foreground" data-profile-reloaded>
                {reloaded}
              </p>
            ) : null}
            {search.new ? (
              <NewProfile
                environmentId={active}
                from={search.from ?? null}
                onMade={(name) => {
                  listRead.refresh();
                  go({ name });
                }}
              />
            ) : search.name ? (
              view ? (
                <ProfileEditor
                  environmentId={active}
                  view={view}
                  onSaved={() => {
                    oneRead.refresh();
                    listRead.refresh();
                  }}
                  onRemoved={() => {
                    listRead.refresh();
                    go({});
                  }}
                  onDuplicate={() => go({ new: true, from: view.profile })}
                />
              ) : (
                <p className="p-6 text-sm text-muted-foreground">
                  {oneRead.error ??
                    (oneRead.isPending ? "Reading the profile." : "There is no such profile.")}
                </p>
              )
            ) : (
              <ProfileList
                profiles={profiles}
                onOpen={(name) => go({ name })}
                onRemove={setRemoving}
              />
            )}
          </ScrollArea>
        )}
      </div>
      {removing ? (
        <RemoveProfileDialog
          environmentId={active}
          profile={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            listRead.refresh();
          }}
        />
      ) : null}
      {opened === "triage" ? (
        <TeamDefaultsDialog environmentId={active} team="triage" onClose={() => setOpened(null)} />
      ) : null}
      {opened === "record" ? (
        <Dialog open onOpenChange={(open) => !open && setOpened(null)}>
          <DialogPopup className="max-w-4xl" data-track-record-dialog>
            <DialogHeader>
              <DialogTitle>Track record</DialogTitle>
              <DialogDescription>
                How often each harness and model was asked and answered, why it did not, how long it
                took, and what it decided, for every team and stage.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <TrackRecord environmentId={active} />
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpened(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </SidebarInset>
  );
}
