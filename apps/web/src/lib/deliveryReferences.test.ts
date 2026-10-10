import { describe, expect, it } from "vite-plus/test";

import { addReference, joinReferencePath } from "./deliveryReferences";

describe("joinReferencePath", () => {
  it.each([
    ["/home/me/work", "docs/a.md", "/home/me/work/docs/a.md"],
    ["/home/me/work/", "docs/a.md", "/home/me/work/docs/a.md"],
    ["/", "a.md", "/a.md"],
    ["/Users/Me", "Docs/A.md", "/Users/Me/Docs/A.md"],
    ["C:/work", "docs/a.md", "C:\\work\\docs\\a.md"],
    ["C:\\work", "docs/a.md", "C:\\work\\docs\\a.md"],
    ["c:\\Work\\", "docs/a.md", "c:\\Work\\docs\\a.md"],
    ["C:/work/docs", "a.md", "C:\\work\\docs\\a.md"],
    ["C:\\", "a.md", "C:\\a.md"],
    ["C:/", "a.md", "C:\\a.md"],
    ["\\\\srv\\share", "a.md", "\\\\srv\\share\\a.md"],
    ["\\\\srv\\share\\", "docs/a.md", "\\\\srv\\share\\docs\\a.md"],
  ])("%s + %s is %s", (root, relative, full) => {
    expect(joinReferencePath(root, relative)).toBe(full);
  });

  it("writes a Windows path with backslashes only", () => {
    expect(joinReferencePath("C:/work", "docs/deep/a.md")).not.toContain("/");
  });
});

describe("addReference", () => {
  it("adds a new file and keeps a repeated one once", () => {
    const once = addReference([], "/work/a.md");
    expect(once).toEqual(["/work/a.md"]);
    expect(addReference(once, "/work/a.md")).toBe(once);
    expect(addReference(once, "/work/a.md/")).toBe(once);
  });

  it("keeps POSIX paths that differ in case apart", () => {
    expect(addReference(["/Work/a.md"], "/work/a.md")).toEqual(["/Work/a.md", "/work/a.md"]);
    expect(addReference(["/a/B.md"], "/a/b.md")).toEqual(["/a/B.md", "/a/b.md"]);
  });

  it("keeps one Windows file whether it came from a project or a browse first", () => {
    const fromProject = joinReferencePath("C:/work", "docs/a.md");
    const fromBrowse = joinReferencePath("C:\\work\\docs", "a.md");
    expect(addReference(addReference([], fromProject), fromBrowse)).toEqual([fromProject]);
    expect(addReference(addReference([], fromBrowse), fromProject)).toEqual([fromBrowse]);
  });

  it("treats a different drive-letter or folder case on Windows as the same file", () => {
    const kept = [joinReferencePath("c:\\work", "docs/a.md")];
    expect(addReference(kept, joinReferencePath("C:\\WORK\\docs", "a.md"))).toBe(kept);
  });

  it("keeps a reference stored with forward slashes as it is", () => {
    const stored = ["C:/work/docs/a.md"];
    const next = addReference(stored, joinReferencePath("C:\\work\\docs", "a.md"));
    expect(next).toBe(stored);
    expect(next).toEqual(["C:/work/docs/a.md"]);
  });

  it("keeps one UNC file across separator styles", () => {
    const kept = [joinReferencePath("\\\\srv\\share", "docs/a.md")];
    expect(addReference(kept, "\\\\SRV\\share/docs/a.md")).toBe(kept);
  });
});
