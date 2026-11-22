import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ServerProvider, UnifiedSettings } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

type Favorites = UnifiedSettings["favorites"];

const favoriteKey = (favorite: Favorites[number]) => `${favorite.provider}\u0000${favorite.model}`;

function moveFavorite(favorites: Favorites, key: string, steps: number): Favorites {
  const from = favorites.findIndex((favorite) => favoriteKey(favorite) === key);
  const to = Math.max(0, Math.min(favorites.length - 1, from + steps));
  if (from === -1 || from === to) return favorites;
  const next = [...favorites];
  const [entry] = next.splice(from, 1);
  if (!entry) return favorites;
  next.splice(to, 0, entry);
  return next;
}

/** The starred models across providers, first choice first. Step buttons serve the keyboard. */
export function FavoriteModelsOrderList(props: {
  readonly favorites: Favorites;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly disabled: boolean;
  readonly onReorder: (next: Favorites) => Promise<unknown>;
}) {
  const gt = useGT();
  // The order a person just made, shown until the server's own has been read back.
  const [saving, setSaving] = useState<Favorites | null>(null);
  const favorites = saving ?? props.favorites;
  const keys = favorites.map(favoriteKey);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const move = (key: string, steps: number) => {
    const next = moveFavorite(favorites, key, steps);
    if (next === favorites) return;
    setSaving(next);
    void props
      .onReorder(next)
      .finally(() => setSaving((current) => (current === next ? null : current)));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const from = keys.indexOf(String(event.active.id));
    const to = keys.indexOf(String(event.over.id));
    if (from !== -1 && to !== -1) move(String(event.active.id), to - from);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={keys} strategy={verticalListSortingStrategy}>
        <ol
          aria-label={gt("Favorite models, first choice first")}
          className="divide-y divide-border/60 rounded-lg border border-border/60"
        >
          {favorites.map((favorite, index) => {
            const provider = props.providers.find(
              (candidate) => candidate.instanceId === favorite.provider,
            );
            return (
              <FavoriteRow
                key={favoriteKey(favorite)}
                id={favoriteKey(favorite)}
                name={
                  provider?.models.find((model) => model.slug === favorite.model)?.name ??
                  favorite.model
                }
                provider={provider?.displayName ?? favorite.provider}
                position={index + 1}
                count={favorites.length}
                disabled={props.disabled}
                onMove={(steps) => move(favoriteKey(favorite), steps)}
              />
            );
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function FavoriteRow(props: {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly position: number;
  readonly count: number;
  readonly disabled: boolean;
  readonly onMove: (steps: number) => void;
}) {
  const gt = useGT();
  const { name } = props;
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.id, disabled: props.disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-x-2 py-1.5 ps-3 pe-1.5",
        isDragging && "relative z-10 rounded-lg bg-background shadow-md",
      )}
    >
      <span className="text-xs tabular-nums text-muted-foreground">{props.position}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm leading-5">{name}</span>
        <span className="truncate text-2xs text-muted-foreground">{props.provider}</span>
      </span>
      <span
        ref={setActivatorNodeRef}
        {...listeners}
        aria-hidden
        className={cn(
          "hidden size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 hover:text-foreground active:cursor-grabbing @min-[32rem]/settings-row:flex",
          props.disabled && "invisible",
        )}
      >
        <GripVerticalIcon className="size-3.5" />
      </span>
      <span className="flex items-center gap-0.5">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.disabled || props.position === 1}
          aria-label={gt("Move {name} up", { name })}
          onClick={() => props.onMove(-1)}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.disabled || props.position === props.count}
          aria-label={gt("Move {name} down", { name })}
          onClick={() => props.onMove(1)}
        >
          <ArrowDownIcon />
        </Button>
      </span>
    </li>
  );
}
