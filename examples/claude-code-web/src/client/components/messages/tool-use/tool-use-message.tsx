import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "@claude-agent-kit/messages";
import type { MessagePartProps } from "../types";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "./markdown-content";
import { ToolSummary } from "./tool-summary";
import { ToolBody } from "./tool-body";
import { getToolRenderer } from "./tool-renderer-factory";
import { getStatusBadge } from "./renderers/base-tool-renderer";
import { SecondaryLine } from "./secondary-line";

type AskUserQuestionOption = {
  label: string;
  description?: string;
};

type AskUserQuestionQuestion = {
  header: string;
  question: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
};

function isNonInteractivePromptPlaceholder(toolResult: ToolResultContentBlock | undefined): boolean {
  const content = (toolResult?.content ?? "").toString().trim();
  return (
    toolResult?.is_error === true &&
    (content.includes("Answer questions?") || content.includes("Exit plan mode?"))
  );
}

function parseAskUserQuestionInput(raw: unknown): AskUserQuestionQuestion[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }

  const input = raw as Record<string, unknown>;
  const questionsRaw = input.questions;
  if (!Array.isArray(questionsRaw)) {
    return [];
  }

  const parsed: AskUserQuestionQuestion[] = [];
  for (const entry of questionsRaw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const q = entry as Record<string, unknown>;
    const header = typeof q.header === "string" ? q.header : "";
    const question = typeof q.question === "string" ? q.question : "";
    const multiSelect = q.multiSelect === true;

    const optionsRaw = Array.isArray(q.options) ? q.options : [];
    const options: AskUserQuestionOption[] = optionsRaw
      .map((opt) => {
        if (!opt || typeof opt !== "object") {
          return null;
        }
        const obj = opt as Record<string, unknown>;
        const label = typeof obj.label === "string" ? obj.label : "";
        if (!label) {
          return null;
        }
        const description = typeof obj.description === "string" ? obj.description : undefined;
        return { label, description } satisfies AskUserQuestionOption;
      })
      .filter(Boolean) as AskUserQuestionOption[];

    if (!question || !header || options.length === 0) {
      continue;
    }

    parsed.push({ header, question, options, multiSelect });
  }

  return parsed;
}

export function ToolUseMessage({ content, context }: MessagePartProps) {
  if (content.content.type !== "tool_use") {
    return null;
  }

  const toolContent = content.content as ToolUseContentBlock;
  const toolResult = content.toolResult as ToolResultContentBlock | undefined;

  const toolUseId = typeof toolContent.id === "string" ? toolContent.id : "";
  const isInteractive =
    toolContent.name === "ExitPlanMode" || toolContent.name === "AskUserQuestion";

  const isPromptPlaceholder = isNonInteractivePromptPlaceholder(toolResult);
  const isResolved = Boolean(toolResult) && !isPromptPlaceholder;

  const renderer = useMemo(
    () => getToolRenderer(toolContent.name, context),
    [toolContent.name, context],
  );

  const [isOpen, setIsOpen] = useState(() => isInteractive && (!toolResult || isPromptPlaceholder));
  const [isSubmitting, setIsSubmitting] = useState(false);

  const askQuestions = useMemo(
    () => (toolContent.name === "AskUserQuestion" ? parseAskUserQuestionInput(toolContent.input) : []),
    [toolContent.input, toolContent.name],
  );
  const [fallbackAnswer, setFallbackAnswer] = useState("");
  const [askState, setAskState] = useState<
    Array<{ selected: string[]; otherSelected: boolean; otherText: string }>
  >([]);

  useEffect(() => {
    if (toolContent.name !== "AskUserQuestion") {
      return;
    }
    setAskState(
      askQuestions.map(() => ({ selected: [], otherSelected: false, otherText: "" })),
    );
  }, [askQuestions, toolContent.name, toolUseId]);

  const header = renderer.header(context, toolContent.input);

  const sendToolResult = useCallback(
    async (content: string, isError: boolean) => {
      if (!context.toolActions?.sendToolResult) {
        return;
      }
      if (!toolUseId) {
        return;
      }

      setIsSubmitting(true);
      try {
        context.toolActions.sendToolResult(toolUseId, content, isError);
      } finally {
        // UX: keep the card visible; backend will later attach toolResult and update status.
        setIsSubmitting(false);
      }
    },
    [context.toolActions, toolUseId],
  );

  const interactiveBody = useMemo(() => {
    if (!isInteractive) {
      return null;
    }

    if (toolContent.name === "ExitPlanMode") {
      const input = toolContent.input as Record<string, unknown> | undefined;
      const plan = typeof input?.plan === "string" ? input.plan : "";

      const statusText = toolResult
        ? toolResult.is_error
          ? "已拒绝该计划"
          : "已批准该计划"
        : null;

      return (
        <ToolBody>
          {plan ? <MarkdownContent content={plan} context={context} /> : null}
          {isResolved ? (
            <SecondaryLine hideBracket>{statusText}</SecondaryLine>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={() => void sendToolResult("User approved the plan", false)}
                disabled={!context.toolActions?.sendToolResult || !toolUseId || isSubmitting}
              >
                批准
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void sendToolResult("User rejected the plan", true)}
                disabled={!context.toolActions?.sendToolResult || !toolUseId || isSubmitting}
              >
                拒绝
              </Button>
            </div>
          )}
        </ToolBody>
      );
    }

    if (toolContent.name === "AskUserQuestion") {
      const statusText = toolResult
        ? toolResult.is_error
          ? ((toolResult.content ?? "").toString().includes("User declined to answer")
              ? "已拒绝回答"
              : "回答处理失败")
          : "已提交回答"
        : null;

      const showControls = !isResolved;
      const canSubmit =
        askQuestions.length > 0
          ? askQuestions.every((q, index) => {
              const state = askState[index];
              if (!state) {
                return false;
              }
              if (q.multiSelect) {
                const hasAny = state.selected.length > 0 || state.otherSelected;
                if (!hasAny) {
                  return false;
                }
              } else {
                if (state.selected.length !== 1 && !state.otherSelected) {
                  return false;
                }
              }
              if (state.otherSelected && !state.otherText.trim()) {
                return false;
              }
              return true;
            })
          : false;

      const handleSubmit = () => {
        if (askQuestions.length === 0) {
          void sendToolResult(fallbackAnswer.trim() || " ", false);
          return;
        }
        const answers: Record<string, string> = {};
        askQuestions.forEach((q, index) => {
          const state = askState[index];
          if (!state) {
            return;
          }
          const selectedParts: string[] = [];
          if (q.multiSelect) {
            selectedParts.push(...state.selected);
          } else if (state.selected[0]) {
            selectedParts.push(state.selected[0]);
          }
          if (state.otherSelected) {
            selectedParts.push(state.otherText.trim());
          }
          answers[q.header] = selectedParts.join("；");
        });
        void sendToolResult(JSON.stringify({ answers }), false);
      };

      return (
        <ToolBody>
          {askQuestions.length > 0 ? (
            <div className="flex flex-col gap-3">
              {askQuestions.map((q, index) => {
                const state = askState[index] ?? { selected: [], otherSelected: false, otherText: "" };
                const selectedSet = new Set(state.selected);
                const toggleOption = (label: string) => {
                  setAskState((prev) => {
                    const next = [...prev];
                    const current = next[index] ?? { selected: [], otherSelected: false, otherText: "" };
                    if (q.multiSelect) {
                      const set = new Set(current.selected);
                      if (set.has(label)) {
                        set.delete(label);
                      } else {
                        set.add(label);
                      }
                      next[index] = { ...current, selected: Array.from(set) };
                      return next;
                    }
                    next[index] = { ...current, selected: [label], otherSelected: false };
                    return next;
                  });
                };

                const toggleOther = () => {
                  setAskState((prev) => {
                    const next = [...prev];
                    const current = next[index] ?? { selected: [], otherSelected: false, otherText: "" };
                    if (q.multiSelect) {
                      next[index] = { ...current, otherSelected: !current.otherSelected };
                      return next;
                    }
                    next[index] = { ...current, selected: [], otherSelected: !current.otherSelected };
                    return next;
                  });
                };

                return (
                  <div key={`${q.header}-${index}`} className="flex flex-col gap-2">
                    <div className="text-xs text-muted-foreground">{q.header}</div>
                    <div className="text-sm text-foreground whitespace-pre-wrap">{q.question}</div>
                    {showControls ? (
                      <div className="flex flex-wrap gap-2">
                        {q.options.map((opt) => (
                          <Button
                            key={opt.label}
                            type="button"
                            variant={selectedSet.has(opt.label) ? "default" : "outline"}
                            onClick={() => toggleOption(opt.label)}
                            disabled={!context.toolActions?.sendToolResult || !toolUseId || isSubmitting}
                          >
                            {opt.label}
                          </Button>
                        ))}
                        <Button
                          type="button"
                          variant={state.otherSelected ? "default" : "outline"}
                          onClick={toggleOther}
                          disabled={!context.toolActions?.sendToolResult || !toolUseId || isSubmitting}
                        >
                          其他
                        </Button>
                      </div>
                    ) : null}
                    {showControls && state.otherSelected ? (
                      <textarea
                        className="min-h-[72px] w-full resize-y rounded border border-border bg-background p-2 text-sm text-foreground"
                        placeholder="请输入你的补充…"
                        value={state.otherText}
                        onChange={(event) => {
                          const value = event.target.value;
                          setAskState((prev) => {
                            const next = [...prev];
                            const current = next[index] ?? { selected: [], otherSelected: true, otherText: "" };
                            next[index] = { ...current, otherText: value };
                            return next;
                          });
                        }}
                        disabled={!context.toolActions?.sendToolResult || !toolUseId || isSubmitting}
                      />
                    ) : null}
                    {q.options.some((opt) => opt.description) ? (
                      <div className="text-xs text-muted-foreground">
                        {q.options
                          .filter((opt) => opt.description)
                          .map((opt) => `${opt.label}：${opt.description}`)
                          .join("  ")}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-sm text-foreground whitespace-pre-wrap">
              Claude 需要你补充信息后继续。
            </div>
          )}
          {showControls && askQuestions.length === 0 ? (
            <textarea
              className="mt-2 min-h-[88px] w-full resize-y rounded border border-border bg-background p-2 text-sm text-foreground"
              placeholder="请输入你的回答…"
              value={fallbackAnswer}
              onChange={(event) => setFallbackAnswer(event.target.value)}
              disabled={!context.toolActions?.sendToolResult || !toolUseId || isSubmitting}
            />
          ) : null}
          {isResolved ? (
            <SecondaryLine hideBracket>{statusText}</SecondaryLine>
          ) : (
            <div className="flex flex-col gap-2 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  onClick={handleSubmit}
                  disabled={
                    !context.toolActions?.sendToolResult ||
                    !toolUseId ||
                    isSubmitting ||
                    (askQuestions.length > 0 && !canSubmit)
                  }
                >
                  提交
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void sendToolResult("User declined to answer", true)}
                  disabled={!context.toolActions?.sendToolResult || !toolUseId || isSubmitting}
                >
                  拒绝
                </Button>
              </div>
            </div>
          )}
        </ToolBody>
      );
    }

    return null;
  }, [
    context,
    context.toolActions?.sendToolResult,
    isInteractive,
    isSubmitting,
    sendToolResult,
    toolContent.input,
    toolContent.name,
    toolResult,
    toolUseId,
    askQuestions,
    fallbackAnswer,
    askState,
    isResolved,
  ]);

  const body = isInteractive ? interactiveBody : renderer.body(context, toolContent.input, toolResult);
  const hasBody = Boolean(body);
  const statusBadge = isInteractive
    ? getStatusBadge(
        isResolved
          ? toolResult.is_error
            ? "output-error"
            : "output-available"
          : "input-streaming",
      )
    : getStatusBadge(renderer.getState(toolResult));

  const handleToggle = () => {
    if (!hasBody) {
      return;
    }
    setIsOpen((prev) => !prev);
  };

  return (
    <div className="flex flex-col gap-2 leading-[1.5]">
      <ToolSummary
        isOpen={isOpen}
        onToggle={hasBody ? handleToggle : undefined}
        status={statusBadge}
      >
        {header}
      </ToolSummary>
      {hasBody ? (isOpen ? body : null) : body}
    </div>
  );
}
