import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarUtilityMenu } from "./SidebarChrome";

vi.mock("../../state/delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/delivery")>()),
  useDeliveryEnabled: () => true,
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
  usePullRequestsSupported: () => true,
}));
vi.mock("../../hooks/useBoardAttention", () => ({ useBoardAttention: () => null }));

function renderAt(path: string) {
  return render(
    <SidebarProvider>
      <SidebarUtilityMenu />
    </SidebarProvider>,
    { router: path },
  );
}

describe("SidebarUtilityMenu", () => {
  it("keeps the utility icons on delivery pages, with an icon to return to chat", async () => {
    await using screen = await renderAt("/board");
    await expect.element(screen.getByRole("button", { name: "Back to chat" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Pull requests" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Usage" })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Board" }))
      .toHaveAttribute("data-active", "true");
    await expect
      .element(screen.getByRole("button", { name: "Deployments" }))
      .not.toHaveAttribute("data-active", "true");
  });

  it("replaces the utility icons with a wide Back button on utility pages", async () => {
    await using screen = await renderAt("/pull-requests");
    await expect.element(screen.getByRole("button", { name: "Back", exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" }).query()).toBeNull();
    expect(screen.getByRole("button", { name: "Usage" }).query()).toBeNull();
    expect(screen.getByRole("button", { name: "Back to chat" }).query()).toBeNull();
  });
});
