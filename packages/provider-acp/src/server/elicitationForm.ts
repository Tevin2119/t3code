import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";

import { unknownRecord } from "./clientPolicy.ts";

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

type Option = OrchestrationV2UserInputQuestion["options"][number];

/** The choices of one field: a plain `enum`, or the titled form (`oneOf`/`anyOf` of `const`). */
function choices(field: Record<string, unknown> | undefined): ReadonlyArray<Option> {
  if (Array.isArray(field?.enum)) {
    return field.enum.flatMap((value): Option[] =>
      typeof value === "string" ? [{ label: value, description: value }] : [],
    );
  }
  const titled = Array.isArray(field?.oneOf) ? field.oneOf : field?.anyOf;
  if (!Array.isArray(titled)) return [];
  return titled.flatMap((entry): Option[] => {
    const record = unknownRecord(entry);
    if (typeof record?.const !== "string") return [];
    const label = text(record.title) ?? record.const;
    return [{ label, description: text(record.description) ?? label, value: record.const }];
  });
}

/** The questions of a form elicitation, one per property of its schema. */
export function elicitationQuestions(
  message: string,
  properties: Record<string, unknown>,
): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  const fields = Object.entries(properties);
  // An agent with no per-field text sends every question in the message, one a line.
  const lines = message.split("\n").flatMap((line) => text(line) ?? []);
  const lineOf = (index: number) => (lines.length === fields.length ? lines[index] : undefined);
  return fields.map(([id, property], index): OrchestrationV2UserInputQuestion => {
    const field = unknownRecord(property);
    const many = field?.type === "array";
    const options = many
      ? choices(unknownRecord(field.items))
      : field?.type === "boolean"
        ? [
            { label: "true", description: "Yes" },
            { label: "false", description: "No" },
          ]
        : choices(field);
    return {
      id,
      header: text(field?.title) ?? `Question ${index + 1}`,
      question: text(field?.description) ?? lineOf(index) ?? text(message) ?? "Question",
      options,
      ...(many && options.length > 0 ? { multiSelect: true } : {}),
      // A field that lists its values takes nothing else, so a typed answer would be dropped.
      ...(options.length > 0 ? { allowCustomAnswer: false } : {}),
    };
  });
}
