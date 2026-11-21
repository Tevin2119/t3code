import { compareSemverVersions } from "@t3tools/shared/semver";
import { expect, it } from "@effect/vitest";

import { parseDeepSeekVersion } from "./DeepSeekProvider.ts";

it("keeps a release candidate's prerelease so a newer candidate counts as an update", () => {
  expect(parseDeepSeekVersion("0.2.2-rc.1\n")).toBe("0.2.2-rc.1");
  expect(parseDeepSeekVersion("dsh v1.4.0 (build 7)")).toBe("1.4.0");
  expect(parseDeepSeekVersion("no version here")).toBeNull();
  expect(compareSemverVersions(parseDeepSeekVersion("0.2.2-rc.1")!, "0.2.2-rc.5")).toBeLessThan(0);
});
