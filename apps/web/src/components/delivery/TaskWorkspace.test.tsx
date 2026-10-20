import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { FullAutoAttribution } from "./TaskWorkspace";

vi.mock("../ui/badge", () => ({ Badge: "strong" }));
let renderer: ReactTestRenderer;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(() => renderer?.unmount());
});
it.each([
  { by: "full auto", fullAuto: null, name: null, since: null },
  {
    by: "full auto, turned on by Alex at 2026-10-19T10:00:00Z",
    fullAuto: null,
    name: "Alex",
    since: "2026-10-19T10:00:00Z",
  },
  {
    by: "full auto, turned on by Alex at oops",
    fullAuto: { by: "Sam", since: "2026-10-19T11:00:00Z" },
    name: "Sam",
    since: "2026-10-19T11:00:00Z",
  },
])(
  "shows a Full auto badge with known attribution only: $by",
  async ({ by, fullAuto, name, since }) => {
    await act(() => {
      renderer = create(<FullAutoAttribution entry={{ by, fullAuto }} />);
    });
    expect(renderer.root.findByType("strong").props.children).toBe("Full auto");
    const output = JSON.stringify(renderer.toJSON());
    if (name) expect(output).toContain(`turned on by ${name}`);
    else expect(output).not.toContain("turned on by");
    if (since)
      expect(output).toContain(
        new Date(since).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
  },
);
it("omits the badge for ordinary actors", async () => {
  await act(() => {
    renderer = create(<FullAutoAttribution entry={{ by: "Sam", fullAuto: null }} />);
  });
  expect(renderer.toJSON()).toBeNull();
});
