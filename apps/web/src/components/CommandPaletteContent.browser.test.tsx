import { FolderIcon } from "lucide-react";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import type { CommandPaletteGroup } from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { CommandDialog, CommandDialogPopup, CommandItem, CommandList } from "./ui/command";

function SubmenuPalette() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandDialogPopup aria-label="Command palette">
          <CommandPaletteContent
            items={["Project A"]}
            inputProps={{
              placeholder: "Search projects",
              startAddon: (
                <button type="button" aria-label="Back">
                  Back
                </button>
              ),
            }}
          >
            <CommandList>
              {(item: string) => <CommandItem value={item}>{item}</CommandItem>}
            </CommandList>
          </CommandPaletteContent>
        </CommandDialogPopup>
      </CommandDialog>
    </>
  );
}

const MANY_FOLDERS: CommandPaletteGroup = {
  value: "directories",
  label: "Directories",
  items: Array.from({ length: 40 }, (_, index) => ({
    kind: "action" as const,
    value: `folder-${index}`,
    searchTerms: [`folder-${index}`],
    title: `folder-${index}`,
    icon: <FolderIcon />,
    run: async () => undefined,
  })),
};

describe("CommandPaletteContent", () => {
  it("focuses the search input, not the Back button, when it opens into a submenu", async () => {
    await using _screen = await render(<SubmenuPalette />);

    await userEvent.click(page.getByRole("button", { name: "Open" }));

    await expect.element(page.getByPlaceholder("Search projects")).toHaveFocus();
  });

  // The board's repository browse puts the palette's content in an ordinary dialog, where nothing
  // above it has a definite height. The list must still scroll inside the panel's bound.
  it("scrolls a long list inside its bound when nothing above it has a height", async () => {
    await using screen = await render(
      <div className="flex w-[32rem] flex-col gap-2 rounded-md border p-2">
        <CommandPaletteContent
          aria-label="Folder of the repository"
          autoHighlight={false}
          escapeLabel="Cancel"
          inputProps={{ "aria-label": "Folder of the repository" }}
          mode="none"
          onValueChange={() => undefined}
          panelSize="list"
          value=""
        >
          <CommandPaletteResults
            groups={[MANY_FOLDERS]}
            highlightedItemValue={null}
            isActionsOnly={false}
            keybindings={[]}
            onExecuteItem={() => undefined}
          />
        </CommandPaletteContent>
      </div>,
    );
    const viewport = screen.container
      .querySelector<HTMLElement>('[data-slot="command-list"]')!
      .closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    const rows = screen.container.querySelectorAll('[data-slot="command-item"]');

    expect(rows.length).toBe(40);
    // 28rem is the panel's bound; the viewport stops there and the rest is reached by scrolling.
    expect(viewport.clientHeight).toBeLessThanOrEqual(28 * 16 + 1);
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    const last = rows[rows.length - 1]!;
    expect(last.getBoundingClientRect().top).toBeGreaterThan(
      viewport.getBoundingClientRect().bottom,
    );
    viewport.scrollTop = viewport.scrollHeight;
    expect(viewport.scrollTop).toBeGreaterThan(0);
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      viewport.getBoundingClientRect().bottom + 1,
    );
  });
});
