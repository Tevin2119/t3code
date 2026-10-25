import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { EnvironmentId } from "@t3tools/contracts";
import { type Ref, useDeferredValue, useEffect, useRef, useState } from "react";

import { eligibleMoveBases } from "../../lib/deliveryMove";
import { shouldLoadNextBranchPageAfterScroll } from "../../state/paginatedBranches";
import { usePaginatedBranches } from "../../state/queries";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "../ui/combobox";
import { SelectButton } from "../ui/select";

export const MOVE_BRANCH_VISIBLE_ROWS = 8;

export function MoveTaskBaseBranchPicker({
  ref,
  ...props
}: {
  readonly environmentId: EnvironmentId | null;
  /** The chosen repository's folder; null while none is chosen. */
  readonly cwd: string | null;
  readonly branches: ReturnType<typeof usePaginatedBranches>;
  readonly deliveryRemote: string | null;
  readonly defaultBase: string | null;
  readonly value: string;
  readonly onChange: (base: string) => void;
  readonly disabled: boolean;
  readonly ref: Ref<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query).trim();
  const searchedBranches = usePaginatedBranches({
    environmentId: props.environmentId,
    cwd: props.cwd,
    query: deferredQuery,
  });
  // The dialog pages eligibility while closed; share those pages until a search is active.
  const branches = deferredQuery ? searchedBranches : props.branches;
  const hasNextPage = branches.data?.nextCursor !== null && branches.data?.nextCursor !== undefined;
  const isInitialLoadPending = branches.isPending && branches.data === null;
  // Filtered by what is typed now, so a reply for an older search shows nothing it would not.
  const words = query.trim().toLowerCase();
  const byName = new Map(branches.refs.map((ref) => [ref.name, ref] as const));
  const names = eligibleMoveBases(branches.refs, props.deliveryRemote).filter(
    (name) => name !== props.defaultBase,
  );
  const all = props.defaultBase ? [props.defaultBase, ...names] : names;
  const items = words ? all.filter((name) => name.toLowerCase().includes(words)) : all;
  const problem = branches.error
    ? branches.error
    : branches.data && !branches.data.isRepo
      ? "This folder is not a git repository."
      : null;
  const status = isInitialLoadPending
    ? "Loading branches…"
    : branches.isFetchingNextPage
      ? "Loading more branches…"
      : hasNextPage
        ? `Showing ${branches.refs.length} of ${branches.data?.totalCount ?? 0} branches`
        : null;

  useEffect(() => {
    if (
      open &&
      deferredQuery &&
      items.length < MOVE_BRANCH_VISIBLE_ROWS &&
      hasNextPage &&
      !branches.error &&
      !branches.isFetchingNextPage
    )
      branches.loadNext();
  }, [open, deferredQuery, items.length, hasNextPage, branches]);

  const listRef = useRef<LegendListRef | null>(null);
  const previousScrollTop = useRef<number | null>(null);
  const changeOpen = (next: boolean) => {
    previousScrollTop.current = null;
    setOpen(next);
    if (!next) setQuery("");
  };
  useEffect(
    () => {
      if (!open) return;
      void listRef.current?.scrollToOffset?.({ offset: 0, animated: false });
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Back to the top for each search.
    [deferredQuery, open],
  );
  const scrollNode = () => {
    const node = listRef.current?.getScrollableNode?.() as
      | { scrollTop: number; scrollHeight: number; clientHeight: number }
      | null
      | undefined;
    return node && typeof node.scrollTop === "number" ? node : null;
  };
  const maybeLoadNext = () => {
    const node = scrollNode();
    if (!node) return;
    const previous = previousScrollTop.current;
    previousScrollTop.current = node.scrollTop;
    if (
      !open ||
      !hasNextPage ||
      !!branches.error ||
      branches.isFetchingNextPage ||
      !shouldLoadNextBranchPageAfterScroll({
        previousScrollTop: previous,
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      })
    ) {
      return;
    }
    branches.loadNext();
  };

  const choose = (name: string) => {
    props.onChange(name);
    changeOpen(false);
  };
  const renderItem = (name: string, index: number) => {
    const ref = byName.get(name);
    const badge =
      name === props.defaultBase
        ? "(default)"
        : ref?.current
          ? "current"
          : ref?.isRemote
            ? "remote"
            : null;
    return (
      <ComboboxItem
        hideIndicator
        key={name}
        index={index}
        value={name}
        onClick={() => choose(name)}
        data-move-task-base-option={name}
      >
        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {badge ? <span className="shrink-0 text-3xs text-muted-foreground">{badge}</span> : null}
        </div>
      </ComboboxItem>
    );
  };

  return (
    <Combobox
      items={items}
      filteredItems={items}
      autoHighlight
      virtualized
      onItemHighlighted={(_value, details) => {
        if (!open || details.index < 0 || details.reason !== "keyboard") return;
        void listRef.current?.scrollIndexIntoView?.({ index: details.index, animated: false });
      }}
      onOpenChange={changeOpen}
      open={open}
      value={props.value || null}
    >
      <ComboboxTrigger
        ref={ref}
        aria-label="Base branch"
        render={<SelectButton size="compact" />}
        disabled={props.disabled}
        data-move-task-base
      >
        <span className={`flex-1 truncate text-left ${props.value ? "" : "text-muted-foreground"}`}>
          {props.value ||
            (props.cwd ? "Choose the branch work starts from" : "Choose a repository first")}
        </span>
      </ComboboxTrigger>
      <ComboboxPopup align="start">
        <div className="flex w-80 flex-col">
          <ComboboxSearchInput
            aria-label="Search branches"
            placeholder="Search branches..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {problem ? (
              <div
                className="flex items-center justify-between gap-2 px-3 pt-2 text-xs text-warning"
                data-move-task-base-problem
              >
                <span className="min-w-0 truncate">{problem}</span>
                <Button size="xs" variant="ghost" onClick={() => branches.refresh()}>
                  Try again
                </Button>
              </div>
            ) : null}
            {isInitialLoadPending ? null : <ComboboxEmpty>No branches found.</ComboboxEmpty>}
            <div className="relative min-h-0 w-full max-h-56 flex-1 overflow-hidden">
              <ComboboxListVirtualized>
                <LegendList<string>
                  ref={listRef}
                  data={items}
                  keyExtractor={(item) => item}
                  renderItem={({ item, index }) => renderItem(item, index)}
                  estimatedItemSize={28}
                  drawDistance={336}
                  onLayout={() => {
                    previousScrollTop.current = scrollNode()?.scrollTop ?? null;
                  }}
                  onScroll={maybeLoadNext}
                  className="scrollbar-gutter-stable overflow-x-hidden overscroll-y-contain ps-1 pe-0 pt-2 pb-1"
                  style={{ maxHeight: "14rem" }}
                />
              </ComboboxListVirtualized>
            </div>
            {status ? <ComboboxStatus>{status}</ComboboxStatus> : null}
          </div>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
