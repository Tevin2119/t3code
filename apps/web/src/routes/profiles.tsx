import { createFileRoute } from "@tanstack/react-router";

import { ProfilePage } from "../components/delivery/ProfilePage";

const isName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9-]{1,39}$/.test(value);

export const Route = createFileRoute("/profiles")({
  validateSearch: (
    raw: Record<string, unknown>,
  ): { name?: string; new?: boolean; from?: string } =>
    raw.new === true
      ? { new: true, ...(isName(raw.from) ? { from: raw.from } : {}) }
      : isName(raw.name)
        ? { name: raw.name }
        : {},
  component: ProfilePage,
});
