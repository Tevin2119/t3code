import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { regroupLanes } from "../../lib/boardLanes";
import { parseCard, type DeliveryLane } from "../../lib/delivery";
import { Lane } from "./BoardPage";

vi.mock("../../state/delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/delivery")>()),
  useBoardPreferences: () => ({ grouping: "none", laneFolds: {}, filters: {} }),
  useBoardControls: () => ({ foldLane: () => {}, setFilters: () => {} }),
}));

const NOW = Date.parse("2026-11-21T10:00:00Z");
const base = { number: 1, title: "A card with a title long enough to wrap onto a second line" };
const raw = (extra: Record<string, unknown>) => ({ ...base, ...extra });

const LANES: ReadonlyArray<DeliveryLane> = [
  {
    lane: "ready",
    title: "Ready",
    cards: [
      parseCard(
        raw({
          id: "q1",
          lane: "ready",
          submitted: "2026-11-21T09:00:00Z",
          rank: 3,
          queue: {
            position: 3,
            cap: 4,
            busy: 4,
            holders: [
              {
                id: "h1",
                number: 41,
                title: "A long holder title that has to wrap inside the card",
              },
              { id: "h2", number: 42, title: "Another holder" },
            ],
          },
        }),
      ),
      parseCard(raw({ id: "q2", number: 2, lane: "intake", submitted: null, rank: 4 })),
    ],
  },
  {
    lane: "implementation",
    title: "Building",
    cards: [
      parseCard(
        raw({ id: "w1", lane: "implementation", run: { stage: "build" }, reworkRounds: 2 }),
      ),
      parseCard(raw({ id: "w2", number: 2, lane: "validation", run: { stage: "qa" } })),
      parseCard(raw({ id: "w3", number: 3, lane: "rework", run: { stage: "qa" } })),
    ],
  },
  {
    lane: "human-review",
    title: "Review",
    cards: [
      parseCard(
        raw({
          id: "n1",
          lane: "human-review",
          waitingOn: "person",
          waitsOnPerson: true,
          questions: 3,
          proposals: 2,
          approveStands: false,
          actions: ["approve", "deliver", "accept-artifacts", "submit", "resume"],
          approvals: [
            { actor: "Avery Longname-Hyphenated", decision: "approve", stands: true },
            { actor: "Sam", decision: "approve", stands: true },
          ],
          paused: { needsPerson: true },
          messages: 128,
          unread: 12,
          last: {
            at: "2026-11-22T10:00:00Z",
            by: "lead-developer-with-a-long-seat-name",
            from: "team",
            kind: "reply",
            text: "A long last line that has to be cut short on the card instead of widening it.",
          },
        }),
      ),
    ],
  },
  {
    lane: "an-engine-lane-this-build-has-not-heard-of",
    title: "Unheard of",
    cards: [parseCard(raw({ id: "u1", lane: "an-engine-lane-this-build-has-not-heard-of" }))],
  },
];

const CASES = [false, true].flatMap((dark) =>
  [
    [1440, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
  ].map(([width, height]) => ({ dark, width: width!, height: height! })),
);

/** The page's dark class for one test, removed on dispose. */
function darkTheme(dark: boolean): Disposable {
  document.documentElement.classList.toggle("dark", dark);
  return { [Symbol.dispose]: () => document.documentElement.classList.remove("dark") };
}

it.each(CASES)(
  "fits every lane and card with no sideways overflow at $width px (dark: $dark)",
  async ({ dark, width, height }) => {
    await page.viewport(width, height);
    using _theme = darkTheme(dark);
    const lanes = regroupLanes(LANES);
    // A view's own lanes in its order, and the unknown lane kept at the end, never dropped.
    expect(lanes.map((lane) => lane.lane)).toEqual([
      "queue",
      "in-work",
      "needs-decision",
      "an-engine-lane-this-build-has-not-heard-of",
    ]);
    await using screen = await render(
      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3" data-delivery-board>
        {lanes.map((lane) => (
          <Lane
            key={lane.lane}
            environmentId={null}
            lane={lane}
            places={new Map([["q1", 3]])}
            total={lane.cards.length}
            grouping="none"
            collapsed={false}
            dragged={null}
            now={NOW}
            busy={false}
            onToggle={() => {}}
            onOpen={() => {}}
            onAction={() => {}}
            onPickTag={() => {}}
          />
        ))}
      </div>,
      { router: false },
    );
    const root = document.documentElement;
    // The page itself never scrolls sideways; the board's own strip is the one that may.
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
    for (const lane of screen.container.querySelectorAll<HTMLElement>("[data-lane]")) {
      const box = lane.getBoundingClientRect();
      for (const el of lane.querySelectorAll<HTMLElement>("*")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        expect(r.right, `${el.tagName} ${el.textContent?.slice(0, 40)}`).toBeLessThanOrEqual(
          box.right + 0.5,
        );
      }
      for (const el of lane.querySelectorAll<HTMLElement>("[data-wait-kind], [data-card-queue]")) {
        expect(el.scrollWidth, el.textContent ?? "").toBeLessThanOrEqual(el.clientWidth + 0.5);
      }
    }
    expect(
      screen.container.querySelector('[data-lane="an-engine-lane-this-build-has-not-heard-of"]'),
    ).not.toBeNull();
    // The waiting lane says what it owes in all, and the card what was said, inside their widths.
    const waiting = screen.container.querySelector('[data-lane="needs-decision"]');
    expect(waiting?.querySelector('[data-lane-questions="3"]')).not.toBeNull();
    expect(waiting?.querySelector('[data-lane-sign-offs="1"]')).not.toBeNull();
    expect(waiting?.querySelector('[data-card-unread="12"]')).not.toBeNull();
    expect(waiting?.querySelector("[data-card-last]")).not.toBeNull();
  },
);
