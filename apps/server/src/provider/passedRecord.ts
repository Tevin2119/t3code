/**
 * What an adapter handed to its harness, for the record.
 *
 * A harness may not say what it runs on. What was sent to it is known all the
 * same, and is kept apart from what the harness confirmed: the arguments it
 * was started with, and the settings sent to it over its protocol. Nothing
 * secret is kept. The value of an argument or a setting whose name speaks of
 * a key, a token or a password is left out, and so is the text of the
 * instructions, which is kept elsewhere.
 *
 * @module provider/passedRecord
 */
import type { SessionConfiguredPayload } from "@t3tools/contracts";

export interface PassedRecord {
  readonly model?: string | null;
  readonly reasoning?: string | null;
  /** The mode, the sandbox or the permission setting by which the access is given. */
  readonly access?: string | null;
  /** The arguments the harness was started with. */
  readonly arguments?: ReadonlyArray<string>;
  /** What was sent over the protocol of the harness, or set in its environment, by name. */
  readonly settings?: Readonly<Record<string, string | number | boolean | null>>;
  /** When the settings were sent: at the start of the session, or with a turn. */
  readonly when: "session" | "turn";
}

const SECRET = /key|token|secret|password|passwd|authorization|bearer|credential|cookie/i;
const LONG = /instructions|system.?prompt|prompt=/i;
const KEPT_OUT = "<kept out>";

function cleanWord(word: string, previous: string | undefined): string {
  // `--api-key value` and `-c name=value`: the name decides, the value is what is kept out.
  if (previous !== undefined && previous.startsWith("-") && SECRET.test(previous)) return KEPT_OUT;
  const at = word.indexOf("=");
  if (at > 0) {
    const name = word.slice(0, at);
    if (SECRET.test(name)) return `${name}=${KEPT_OUT}`;
    if (LONG.test(name)) return `${name}=<${word.length - at - 1} characters>`;
  }
  return word.length > 300 ? `${word.slice(0, 120)}... <${word.length} characters>` : word;
}

export function cleanArguments(words: ReadonlyArray<string>): ReadonlyArray<string> {
  return words.map((word, at) => cleanWord(word, words[at - 1]));
}

export function cleanSettings(
  settings: Readonly<Record<string, string | number | boolean | null | undefined>>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(settings)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [
        name,
        SECRET.test(name)
          ? KEPT_OUT
          : typeof value === "string"
            ? cleanWord(value, undefined)
            : (value ?? null),
      ]),
  );
}

/** The payload of a `session.configured` event that says what was handed to the harness. */
export function passedPayload(passed: PassedRecord): SessionConfiguredPayload {
  return {
    config: {
      passed: {
        when: passed.when,
        ...(passed.model !== undefined ? { model: passed.model } : {}),
        ...(passed.reasoning !== undefined ? { reasoning: passed.reasoning } : {}),
        ...(passed.access !== undefined ? { access: passed.access } : {}),
        ...(passed.arguments ? { arguments: cleanArguments(passed.arguments) } : {}),
        ...(passed.settings ? { settings: cleanSettings(passed.settings) } : {}),
      },
    },
  };
}
