import { useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { act } from "../../../test/act";
import { DeliveryApprovalDialog, type DeliveryApprovalResult } from "./DeliveryApprovalDialog";

vi.mock("../ui/dialog", () => ({
  Dialog: "dialog",
  DialogPopup: "dialog-popup",
  DialogPanel: "section",
  DialogHeader: "header",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogFooter: "footer",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "checkbox" }));

const SECRET = "test-only-passphrase";

interface Fiber {
  tag: number;
  memoizedProps: unknown;
  memoizedState: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
}

/** Where the value appears in any component's state hooks or any element's props. */
function retained(renderer: ReactTestRenderer, value: string): string[] {
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const search = (node: unknown, path: string, depth: number): void => {
    if (node === value) found.push(path);
    if (depth > 6 || node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    for (const [name, child] of Object.entries(node)) {
      // A ref leads to the input element, whose own value is where a typed key belongs.
      if (name === "_owner" || name === "_store" || name === "ref") continue;
      search(child, `${path}.${name}`, depth + 1);
    }
  };
  const walk = (fiber: Fiber | null, path: string): void => {
    for (let at = fiber, index = 0; at; at = at.sibling, index += 1) {
      const here = `${path}/${index}`;
      search(at.memoizedProps, `${here}:props`, 0);
      // Function components keep hooks as a list. State hooks have a queue; refs do not, and a
      // ref to the input element is how the key is meant to be read.
      if ([0, 11, 14, 15].includes(at.tag)) {
        let hook = at.memoizedState as { memoizedState: unknown; queue: unknown; next: unknown };
        for (let slot = 0; hook; slot += 1, hook = hook.next as typeof hook)
          if (hook.queue) search(hook.memoizedState, `${here}:state${slot}`, 0);
      }
      walk(at.child, here);
    }
  };
  walk((renderer.root as unknown as { _fiber: Fiber })._fiber, "");
  return found;
}

async function mount(
  overrides: Partial<Parameters<typeof DeliveryApprovalDialog>[0]> = {},
  submit: (key: string) => Promise<DeliveryApprovalResult> = async () => ({ ok: true }),
) {
  const element = { value: "" };
  const onSubmit = vi.fn(({ key }: { key: string }) => submit(key));
  const onDone = vi.fn();
  const onClose = vi.fn();
  const props = {
    title: "Sign",
    person: "Sam",
    nameField: true,
    keyLabel: "Approval key",
    forbidden: "No permission",
    submitLabel: "Sign",
    onSubmit,
    onDone,
    onClose,
    ...overrides,
  };
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(<DeliveryApprovalDialog {...props} />, {
      createNodeMock: (node) =>
        (node.props as { type?: string }).type === "password" ? element : null,
    });
  });
  const key = () => renderer.root.findByProps({ type: "password" });
  const button = (label: string) =>
    renderer.root.findAllByType("button").find((node) => node.props.children === label)!;
  return {
    renderer,
    element,
    onSubmit,
    onDone,
    onClose,
    update: (next: Partial<typeof props>) =>
      act(() => renderer.update(<DeliveryApprovalDialog {...props} {...next} />)),
    type: async (value: string) => {
      element.value = value;
      await act(() => key().props.onChange({ target: element }));
    },
    key,
    button,
    async [Symbol.asyncDispose]() {
      await act(() => renderer.unmount());
    },
  };
}

it("finds a value held in React state, so a clean result means something", async () => {
  function Controlled() {
    const [value] = useState(SECRET);
    return <input type="password" defaultValue="" data-length={value.length} />;
  }
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(<Controlled />);
  });
  expect(retained(renderer, SECRET)).not.toHaveLength(0);
  await act(() => renderer.unmount());
});

it("keeps the key out of React state, and empties the input after a wrong key, a success and a cancel", async () => {
  const answers: DeliveryApprovalResult[] = [{ ok: false, why: "Wrong key" }, { ok: true }];
  await using view = await mount({}, async () => answers.shift()!);
  await view.type(SECRET);
  expect(view.key().props.value).toBeUndefined();
  expect(retained(view.renderer, SECRET)).toEqual([]);

  await act(async () => view.button("Sign").props.onClick());
  expect(view.onSubmit).toHaveBeenCalledExactlyOnceWith({
    by: "Sam",
    key: SECRET,
    confirmed: false,
  });
  // A wrong key leaves the dialog open, says why, and asks for the key again.
  expect(view.onDone).not.toHaveBeenCalled();
  expect(view.onClose).not.toHaveBeenCalled();
  expect(view.renderer.root.findByProps({ role: "alert" }).props.children).toBe("Wrong key");
  expect(view.element.value).toBe("");
  expect(view.button("Sign").props.disabled).toBe(true);
  expect(retained(view.renderer, SECRET)).toEqual([]);

  await view.type(SECRET);
  await act(async () =>
    view.renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }),
  );
  expect(view.onDone).toHaveBeenCalledExactlyOnceWith("Sam");
  expect(view.element.value).toBe("");
  expect(retained(view.renderer, SECRET)).toEqual([]);

  await view.type(SECRET);
  await act(() => view.button("Cancel").props.onClick());
  expect(view.onClose).toHaveBeenCalledOnce();
  expect(view.element.value).toBe("");
  expect(retained(view.renderer, SECRET)).toEqual([]);
});

it("sends one request for a double submit, and keeps the dialog open while it runs", async () => {
  let settle: (result: DeliveryApprovalResult) => void = () => {};
  await using view = await mount(
    {},
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await view.type(SECRET);
  await act(() => {
    view.button("Sign").props.onClick();
    view.renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  expect(view.onSubmit).toHaveBeenCalledTimes(1);
  expect(view.element.value).toBe("");
  await act(() => view.renderer.root.findByType("dialog").props.onOpenChange(false));
  expect(view.onClose).not.toHaveBeenCalled();
  await act(() => settle({ ok: true }));
  expect(view.onDone).toHaveBeenCalledOnce();
});

it("stays invalidated when permission is lost while open, even after it returns", async () => {
  await using view = await mount({ allowed: true });
  await view.type(SECRET);
  expect(view.button("Sign").props.disabled).toBe(false);
  await view.update({ allowed: false });
  expect(view.button("Sign").props.disabled).toBe(true);
  await view.update({ allowed: true });
  expect(view.button("Sign").props.disabled).toBe(true);
  expect(view.renderer.root.findByProps({ role: "status" }).props.children).toBe("No permission");
  await act(async () => view.button("Sign").props.onClick());
  expect(view.onSubmit).not.toHaveBeenCalled();
});
