import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Option label shown to the user" }),
  description: Type.Optional(Type.String({ description: "Optional extra detail" })),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Stable id for this question" }),
  prompt: Type.String({ description: "Question text" }),
  options: Type.Array(OptionSchema, { minItems: 1, description: "Choices" }),
  allowOther: Type.Optional(
    Type.Boolean({ description: "Allow a free-text answer (default true)" }),
  ),
});

const Params = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    description: "One or more multiple-choice questions",
  }),
});

const OTHER = "Other (type answer)";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user one or more multiple-choice questions. Use when a decision, preference, or clarification is required before continuing.",
    promptSnippet: "Ask the user structured multiple-choice questions",
    promptGuidelines: [
      "Prefer ask_user over guessing when requirements or choices are ambiguous.",
      "Keep options short and mutually exclusive.",
    ],
    parameters: Params,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text" as const, text: "Error: UI not available" }],
          details: { answers: [], cancelled: true },
        };
      }

      const answers: Array<{ id: string; answer: string; wasCustom: boolean }> = [];

      for (const question of params.questions) {
        if (signal?.aborted) {
          return {
            content: [{ type: "text" as const, text: "Cancelled" }],
            details: { answers, cancelled: true },
          };
        }

        const allowOther = question.allowOther !== false;
        const choices: Array<{ display: string; option?: (typeof question.options)[number] }> = question.options.map((option, index) => ({
          display: `${index + 1}. ${option.description ? `${option.label} — ${option.description}` : option.label}`,
          option,
        }));
        if (allowOther) choices.push({ display: `${choices.length + 1}. ${OTHER}` });

        // Question ids are for the model's answer bookkeeping, not the user.
        const title =
          params.questions.length > 1
            ? `(${params.questions.indexOf(question) + 1}/${params.questions.length}) ${question.prompt}`
            : question.prompt;

        const selected = await ctx.ui.select(
          title,
          choices.map((choice) => choice.display),
          { signal },
        );
        if (selected === undefined) {
          return {
            content: [{ type: "text" as const, text: "User cancelled" }],
            details: { answers, cancelled: true },
          };
        }

        const choice = choices.find((choice) => choice.display === selected)!;

        if (!choice.option) {
          const custom = await ctx.ui.input(question.prompt, "Type your answer", { signal });
          if (custom === undefined || !custom.trim()) {
            return {
              content: [{ type: "text" as const, text: "User cancelled" }],
              details: { answers, cancelled: true },
            };
          }
          answers.push({ id: question.id, answer: custom.trim(), wasCustom: true });
          continue;
        }

        answers.push({
          id: question.id,
          answer: choice.option.label,
          wasCustom: false,
        });
      }

      const lines = answers.map((a) => `- ${a.id}: ${a.answer}${a.wasCustom ? " (custom)" : ""}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `User answers:\n${lines.join("\n")}`,
          },
        ],
        details: { answers, cancelled: false },
      };
    },
  });
}
