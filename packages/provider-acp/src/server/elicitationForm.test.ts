import { assert, it } from "@effect/vitest";

import { elicitationQuestions } from "./elicitationForm.ts";

it("gives each question of a form its own text and its titled choices", () => {
  const option = (label: string) => ({ const: label, title: label, description: `${label}.` });
  const questions = elicitationQuestions(
    "How should it reach master?\nWhat goes into the commit?",
    {
      q0: { type: "string", title: "Routing", oneOf: [option("Pipeline"), option("Hotfix")] },
      q1: { type: "array", title: "Scope", minItems: 1, items: { anyOf: [option("Trim")] } },
    },
  );
  assert.deepStrictEqual(questions, [
    {
      id: "q0",
      header: "Routing",
      question: "How should it reach master?",
      options: [
        { label: "Pipeline", description: "Pipeline.", value: "Pipeline" },
        { label: "Hotfix", description: "Hotfix.", value: "Hotfix" },
      ],
      allowCustomAnswer: false,
    },
    {
      id: "q1",
      header: "Scope",
      question: "What goes into the commit?",
      options: [{ label: "Trim", description: "Trim.", value: "Trim" }],
      multiSelect: true,
      allowCustomAnswer: false,
    },
  ]);

  // A field's own description wins, and a message that is not one line a field is kept whole.
  assert.deepStrictEqual(
    elicitationQuestions("Fill in the release.", {
      name: { type: "string", description: "Its name" },
      draft: { type: "boolean" },
      channel: { type: "string", enum: ["qa", "main"] },
    }).map((question) => [question.question, question.options.map((item) => item.label)]),
    [
      ["Its name", []],
      ["Fill in the release.", ["true", "false"]],
      ["Fill in the release.", ["qa", "main"]],
    ],
  );
});
