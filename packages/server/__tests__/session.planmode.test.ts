import { describe, expect, it, vi } from "vitest";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { Session } from "../src/server/session";
import type { IClaudeAgentSDKClient } from "../src/types";

function createMockSdkClient() {
  return {
    queryStream: vi.fn(),
    loadMessages: vi.fn(),
  } satisfies IClaudeAgentSDKClient;
}

function createSdkMessage(overrides: Record<string, unknown>): SDKMessage {
  return {
    type: "system",
    message: { content: [] },
    session_id: "",
    uuid: "uuid" as never,
    ...overrides,
  } as unknown as SDKMessage;
}

function createAssistantToolUseMessage(params: {
  id: string;
  name: string;
  input?: Record<string, unknown>;
}): SDKMessage {
  return createSdkMessage({
    type: "assistant",
    session_id: "s-1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: params.id,
          name: params.name,
          input: params.input ?? {},
        },
      ],
    },
  });
}

async function captureFirstUserMessageFromQuery(
  sdkClient: ReturnType<typeof createMockSdkClient>,
): Promise<{ session: Session; captured: { message: SDKUserMessage } }> {
  const captured: { message: SDKUserMessage } = { message: undefined as never };

  sdkClient.queryStream.mockImplementation(async function* (
    prompt: string | AsyncIterable<SDKUserMessage>,
  ) {
    if (typeof prompt !== "string") {
      for await (const entry of prompt) {
        captured.message = entry;
        break;
      }
    }

    yield createSdkMessage({
      type: "result",
      session_id: "s-1",
      timestamp: 1,
    });
  });

  const session = new Session(sdkClient);
  return { session, captured };
}

describe("Session plan-mode tool_result fallbacks", () => {
  it("maps '执行' to ExitPlanMode tool_result approve when pending", async () => {
    const sdkClient = createMockSdkClient();
    const { session, captured } = await captureFirstUserMessageFromQuery(sdkClient);

    (session as any).messageList = [
      createAssistantToolUseMessage({
        id: "toolu_exit",
        name: "ExitPlanMode",
        input: { plan: "do something" },
      }),
    ];

    await session.send("执行", undefined);

    const blocks = captured.message.message.content as Array<Record<string, unknown>>;
    expect(blocks[0]?.type).toBe("tool_result");
    expect(blocks[0]?.tool_use_id).toBe("toolu_exit");
    expect(blocks[0]?.is_error).toBe(false);
  });

  it("maps '拒绝' to ExitPlanMode tool_result reject when pending", async () => {
    const sdkClient = createMockSdkClient();
    const { session, captured } = await captureFirstUserMessageFromQuery(sdkClient);

    (session as any).messageList = [
      createAssistantToolUseMessage({
        id: "toolu_exit",
        name: "ExitPlanMode",
      }),
    ];

    await session.send("拒绝", undefined);

    const blocks = captured.message.message.content as Array<Record<string, unknown>>;
    expect(blocks[0]?.type).toBe("tool_result");
    expect(blocks[0]?.tool_use_id).toBe("toolu_exit");
    expect(blocks[0]?.is_error).toBe(true);
  });

  it("treats user text as AskUserQuestion tool_result answer when pending", async () => {
    const sdkClient = createMockSdkClient();
    const { session, captured } = await captureFirstUserMessageFromQuery(sdkClient);

    (session as any).messageList = [
      createAssistantToolUseMessage({
        id: "toolu_ask",
        name: "AskUserQuestion",
        input: { question: "q?" },
      }),
    ];

    await session.send("我的回答", undefined);

    const blocks = captured.message.message.content as Array<Record<string, unknown>>;
    expect(blocks[0]?.type).toBe("tool_result");
    expect(blocks[0]?.tool_use_id).toBe("toolu_ask");
    expect(blocks[0]?.is_error).toBe(false);
    expect(blocks[0]?.content).toBe("我的回答");
  });

  it("keeps AskUserQuestion pending when the transcript contains the non-interactive placeholder error", async () => {
    const sdkClient = createMockSdkClient();
    const { session, captured } = await captureFirstUserMessageFromQuery(sdkClient);

    (session as any).messageList = [
      createAssistantToolUseMessage({
        id: "toolu_ask",
        name: "AskUserQuestion",
        input: { questions: [{ header: "h", question: "q?", options: [{ label: "a", description: "d" }, { label: "b", description: "d" }], multiSelect: false }] },
      }),
      createSdkMessage({
        type: "user",
        session_id: "s-1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_ask",
              content: "Answer questions?",
              is_error: true,
            },
          ],
        },
      }),
    ];

    await session.send("我的回答", undefined);

    const blocks = captured.message.message.content as Array<Record<string, unknown>>;
    expect(blocks[0]?.type).toBe("tool_result");
    expect(blocks[0]?.tool_use_id).toBe("toolu_ask");
    expect(blocks[0]?.is_error).toBe(false);
    expect(blocks[0]?.content).toBe("我的回答");
  });

  it("does not treat explicit AskUserQuestion decline as pending", async () => {
    const sdkClient = createMockSdkClient();
    const { session, captured } = await captureFirstUserMessageFromQuery(sdkClient);

    (session as any).messageList = [
      createAssistantToolUseMessage({
        id: "toolu_ask",
        name: "AskUserQuestion",
      }),
      createSdkMessage({
        type: "user",
        session_id: "s-1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_ask",
              content: "User declined to answer",
              is_error: true,
            },
          ],
        },
      }),
    ];

    await session.send("继续", undefined);

    const blocks = captured.message.message.content as Array<Record<string, unknown>>;
    expect(blocks[0]?.type).toBe("text");
  });
});
