import type { WebSocket } from "ws";
import type {
  IClaudeAgentSDKClient,
  ISessionClient,
  OutcomingMessage,
} from "@claude-agent-kit/server";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";


export class WebSocketSessionClient implements ISessionClient {
  sessionId: string | undefined;
  sdkClient: IClaudeAgentSDKClient;
  webSocket: WebSocket;

  constructor(sdkClient: IClaudeAgentSDKClient, webSocket: WebSocket, sessionId?: string) {
    this.sdkClient = sdkClient;
    this.webSocket = webSocket;
    this.sessionId = sessionId;
  }

  receiveSessionMessage(_event: string, message: OutcomingMessage): void {
    try {
      if (process.env.DEBUG?.includes("session-client")) {
        console.log(
          `[WebSocketSessionClient] sending ${message.type} for session ${message.sessionId ?? "unknown"}`,
        );
      }
      this.webSocket.send(JSON.stringify(sanitizeOutcomingMessage(message)));
    } catch (error) {
      console.error("Failed to send WebSocket message:", error);
    }
  }
}

function sanitizeOutcomingMessage(message: OutcomingMessage): OutcomingMessage {
  if (message.type === "message_added") {
    return {
      ...message,
      message: sanitizeSdkMessage(message.message),
    };
  }

  if (message.type === "messages_updated") {
    return {
      ...message,
      messages: message.messages.map(sanitizeSdkMessage),
    };
  }

  return message;
}

function sanitizeSdkMessage(message: SDKMessage): SDKMessage {
  // 仅做轻量“输出净化”：避免把技能目录/技能源码等内部信息回传到前端。
  if (!message || typeof message !== "object") {
    return message;
  }

  if (message.type !== "user") {
    return message;
  }

  const user = message as unknown as {
    message?: { content?: Array<Record<string, unknown>> };
  };

  const content = Array.isArray(user.message?.content) ? user.message?.content : [];
  if (content.length === 0) {
    return message;
  }

  let changed = false;
  const nextContent = content.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
    if (block.type !== "tool_result") {
      return block;
    }

    const raw = (block as { content?: unknown }).content;
    if (typeof raw !== "string") {
      return block;
    }

    if (!raw.includes("Base directory for this skill:")) {
      return block;
    }

    changed = true;
    return {
      ...block,
      // 用更友好的信息替换掉技能目录/技能内容输出
      content: "<command-message>技能已启动</command-message>",
    };
  });

  if (!changed) {
    return message;
  }

  return {
    ...(message as Record<string, unknown>),
    message: {
      ...(user.message ?? {}),
      content: nextContent,
    },
  } as SDKMessage;
}
