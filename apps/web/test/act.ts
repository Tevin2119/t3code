import { act as reactAct } from "react";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// React warns about every update outside act() while this flag is on, and a real
// browser drives updates from userEvent, timers and network that act() cannot wrap.
// So it is on only while act() runs, and nested calls restore the outer value.
export async function act<T>(callback: () => T | Promise<T>): Promise<T> {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    return await reactAct(async () => await callback());
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}
