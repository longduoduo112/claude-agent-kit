import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketSessionClient } from "../src/websocket-session-client";
import type {
  IClaudeAgentSDKClient,
  OutcomingMessage,
} from "@claude-agent-kit/server";

function createMockSdkClient(): IClaudeAgentSDKClient {
  return {
    queryStream: vi.fn(),
    loadMessages: vi.fn(),
  };
}

function createMockWebSocket() {
  return {
    send: vi.fn(),
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

describe("WebSocketSessionClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes session messages over the socket", () => {
    const ws = createMockWebSocket();
    const client = new WebSocketSessionClient(createMockSdkClient(), ws);
    const message: OutcomingMessage = {
      type: "session_state_changed",
      sessionId: "abc",
      sessionState: { isBusy: true },
    };

    client.receiveSessionMessage("event", message);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(message));
  });

  it("logs an error if the socket send fails", () => {
    const ws = createMockWebSocket();
    ws.send.mockImplementation(() => {
      throw new Error("boom");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = new WebSocketSessionClient(createMockSdkClient(), ws);
    const message: OutcomingMessage = {
      type: "session_state_changed",
      sessionId: null,
      sessionState: { isLoading: true },
    };

    client.receiveSessionMessage("event", message);

    expect(consoleSpy).toHaveBeenCalled();
  });

  it("redacts skill directory output from tool results", () => {
    const ws = createMockWebSocket();
    const client = new WebSocketSessionClient(createMockSdkClient(), ws);

    const message: OutcomingMessage = {
      type: "message_added",
      sessionId: "abc",
      message: {
        type: "user",
        uuid: "user-1",
        session_id: "abc",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              is_error: false,
              content:
                "Base directory for this skill: /tmp/skills/consultative-selling\n# SKILL\n...",
            },
          ],
        },
      } as any,
    };

    client.receiveSessionMessage("event", message);

    const sent = ws.send.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sent) as OutcomingMessage;
    expect(JSON.stringify(parsed)).not.toContain("Base directory for this skill:");
  });
});
