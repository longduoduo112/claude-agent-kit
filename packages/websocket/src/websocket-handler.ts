import type { WebSocket } from "ws";
import {
  SessionManager,
  type ChatIncomingMessage,
  type IClaudeAgentSDKClient,
  type IncomingMessage,
  type ResumeSessionIncomingMessage,
  type StartConsultationIncomingMessage,
  type SessionSDKOptions,
  type SetSDKOptionsIncomingMessage,
  type ToolResultIncomingMessage,
} from "@claude-agent-kit/server";
import { WebSocketSessionClient } from "./websocket-session-client";

export class WebSocketHandler {
  private clients: Map<WebSocket, WebSocketSessionClient> = new Map();
  private sessionManager = new SessionManager();
  private warnedCwdOverrides = new WeakSet<WebSocket>();

  sdkClient: IClaudeAgentSDKClient;
  options: SessionSDKOptions;

  constructor(sdkClient: IClaudeAgentSDKClient, options: SessionSDKOptions) {
    this.sdkClient = sdkClient;
    this.options = options;
  }

  private send(ws: WebSocket, payload: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      console.error("Failed to send WebSocket message:", error);
    }
  }

  public async onOpen(ws: WebSocket) {
    const client = new WebSocketSessionClient(this.sdkClient, ws);
    this.clients.set(ws, client);
    console.log('WebSocket client connected:', client.sessionId);
    this.sessionManager.subscribe(client);
    try {
      this.sessionManager.setSDKOptions(client, this.options);
    } catch (error) {
      console.error("Failed to apply default SDK options:", error);
    }

    this.send(ws, { type: "connected", message: 'Connected to the Claude Code WebSocket server.' });
  }

  public onClose(ws: WebSocket) {
    const client = this.clients.get(ws);
    if (!client) {
      console.error("WebSocket client not registered on close");
      return;
    }
    console.log('WebSocket client disconnected:', client.sessionId);
    this.sessionManager.unsubscribe(client);
    this.clients.delete(ws);
  }

  public async onMessage(ws: WebSocket, rawMessage: string): Promise<void> {
    let message: IncomingMessage;
    try {
      message = JSON.parse(rawMessage) as IncomingMessage;
    } catch (error) {
      console.error("Failed to parse WebSocket message:", error);
      this.send(ws, { type: "error", error: "Invalid JSON payload" });
      return;
    }

    switch (message.type) {
      case "chat":
        await this.handleChatMessage(ws, message);
        break;
      case "setSDKOptions":
        await this.handleSetSDKOptions(ws, message);
        break;
      case "resume":
        await this.handleResumeMessage(ws, message);
        break;
      case "toolResult":
        await this.handleToolResultMessage(ws, message);
        break;
      case "startConsultation":
        await this.handleStartConsultation(ws, message);
        break;
      default:
        this.send(ws, {
          type: "error",
          error: `Unsupported message type: ${String((message as { type?: unknown }).type)}`,
          code: "unsupported_message_type",
        });
        break;
    }

  }


  private async handleSetSDKOptions(ws: WebSocket, message: SetSDKOptionsIncomingMessage): Promise<void> {
    const client = this.clients.get(ws);
    if (!client) {
      console.error("WebSocket client not registered");
      this.send(ws, { type: "error", error: "WebSocket client not registered" });
      return;
    }

    const requestedSessionId = typeof message.sessionId === "string" ? message.sessionId.trim() : null;
    if (requestedSessionId) {
      client.sessionId = requestedSessionId;
    }

    try {
      const requestedCwd = (message.options as { cwd?: unknown } | undefined)?.cwd;
      if (requestedCwd !== undefined) {
        if (!this.warnedCwdOverrides.has(ws)) {
          this.warnedCwdOverrides.add(ws);
          console.warn(
            `[WebSocketHandler] Ignored client setSDKOptions.cwd=${String(requestedCwd)}; server uses a fixed PROJECT_ROOT cwd bucket to avoid resume failures from split storage.`,
          );
        }
      }

      const sanitizedOptions = { ...message.options } as Record<string, unknown>;
      delete sanitizedOptions.cwd;

      this.sessionManager.setSDKOptions(client, sanitizedOptions as Partial<SessionSDKOptions>);
    } catch (error) {
      console.error("Failed to set SDK options:", error);
      this.send(ws, { type: "error", error: "Failed to set SDK options" });
    }
  }

  private async handleChatMessage(ws: WebSocket, message: ChatIncomingMessage): Promise<void> {
    const client = this.clients.get(ws);
    if (!client) {
      console.error("WebSocket client not registered");
      return;
    }

    const content = message.content?.trim();
    if (!content) {
      this.send(ws, {
        type: "error",
        error: "Message content cannot be empty",
        code: "empty_message",
      });
      return;
    }

    const requestedSessionId = typeof message.sessionId === "string" ? message.sessionId.trim() : null;

    if (!requestedSessionId) {
      // 客户端未指定 sessionId：通常表示“继续当前会话（未从 URL/状态指定）”。
      // 但如果 client 当前已经绑定了一个旧 sessionId，则这是“开启新会话”的显式信号（New Session）。
      // 关键点：开启新会话时必须清除 SessionManager 对该 client 的 WeakMap 绑定，
      // 否则后续 sendMessage() 会复用旧 Session，导致 UI 跳回旧 sessionId。
      const shouldStartNewSession = Boolean(client.sessionId) || message.newConversation === true;
      if (shouldStartNewSession) {
        this.sessionManager.unsubscribe(client);
        client.sessionId = undefined;

        // Ensure the new session inherits the default options (e.g. CWD)
        try {
          this.sessionManager.setSDKOptions(client, this.options);
        } catch (error) {
          console.error("Failed to apply default SDK options to new session:", error);
        }
      }
    }

    if (requestedSessionId) {
      client.sessionId = requestedSessionId;
    }

    this.sessionManager.sendMessage(client, content, message.attachments);
  }

  private async handleToolResultMessage(ws: WebSocket, message: ToolResultIncomingMessage): Promise<void> {
    const client = this.clients.get(ws);
    if (!client) {
      console.error("WebSocket client not registered");
      this.send(ws, { type: "error", error: "WebSocket client not registered" });
      return;
    }

    const requestedSessionId = typeof message.sessionId === "string" ? message.sessionId.trim() : null;
    if (requestedSessionId) {
      client.sessionId = requestedSessionId;
    }

    const toolUseId = typeof message.toolUseId === "string" ? message.toolUseId.trim() : "";
    if (!toolUseId) {
      this.send(ws, {
        type: "error",
        error: "toolUseId is required",
        code: "invalid_tool_use_id",
      });
      return;
    }

    const content = typeof message.content === "string" ? message.content : "";
    const isError = message.isError === true;

    try {
      await this.sessionManager.sendToolResult(client, toolUseId, content, isError);
    } catch (error) {
      console.error("Failed to send tool result:", error);
      this.send(ws, { type: "error", error: "Failed to send tool result" });
    }
  }

  private async handleResumeMessage(ws: WebSocket, message: ResumeSessionIncomingMessage): Promise<void> {
    const client = this.clients.get(ws);
    if (!client) {
      console.error("WebSocket client not registered");
      this.send(ws, { type: "error", error: "WebSocket client not registered" });
      return;
    }

    const targetSessionId = message.sessionId?.trim();
    console.log(`[WebSocketHandler] Client ${client.sessionId ?? "unknown"} requested resume to ${targetSessionId}`, message);
    if (!targetSessionId) {
      this.send(ws, {
        type: "error",
        error: "Session ID is required to resume",
        code: "invalid_session_id",
      });
      return;
    }

    const previousSessionId = client.sessionId;
    if (previousSessionId && previousSessionId !== targetSessionId) {
      // 关键：必须通过 SessionManager 解绑，确保清理 WeakMap(client->session)，避免跨会话复用旧 Session 导致 options/MCP 配置串话。
      this.sessionManager.unsubscribe(client);
      console.log(`[WebSocketHandler] Unsubscribed client from previous session ${previousSessionId} (cleared bindings)`);
    }

    client.sessionId = targetSessionId;

    const session = this.sessionManager.getOrCreateSession(client);

    // Check if this session has any messages - if not, it's newly created
    // and needs default options applied
    const isNewSession = session.messages.length === 0;

    if (isNewSession) {
      try {
        this.sessionManager.setSDKOptions(client, this.options);
      } catch (error) {
        console.error("Failed to apply default SDK options to resumed session:", error);
      }
    }

    session.subscribe(client);
    client.sessionId = targetSessionId;
    console.log(`[WebSocketHandler] Client subscribed to ${targetSessionId}, session has ${session.messages.length} messages loaded`);

    try {
      await session.resumeFrom(targetSessionId);
      console.log(`[WebSocketHandler] Resume completed for ${targetSessionId}`);
    } catch (error) {
      console.error(`Failed to resume session '${targetSessionId}':`, error);
      this.send(ws, {
        type: "error",
        error: "Failed to resume session",
        code: "resume_failed",
      });
    }
  }

  private buildConsultationOptions(
    base: SessionSDKOptions,
  ): SessionSDKOptions {
    return {
      ...base,
      // 咨询入口明确跳过 Plan Mode
      permissionMode: "default",
    };
  }

  private async handleStartConsultation(
    ws: WebSocket,
    message: StartConsultationIncomingMessage,
  ): Promise<void> {
    const client = this.clients.get(ws);
    if (!client) {
      console.error("WebSocket client not registered");
      this.send(ws, { type: "error", error: "WebSocket client not registered" });
      return;
    }

    const preset = typeof message.preset === "string" ? message.preset.trim() : "";
    if (preset !== "consultative-selling") {
      this.send(ws, {
        type: "error",
        error: `Unsupported consultation preset: ${preset || "(empty)"}`,
        code: "unsupported_consultation_preset",
      });
      return;
    }

    // 强制开启新会话：解绑旧会话，清除 client/session 绑定
    try {
      this.sessionManager.unsubscribe(client);
    } catch {
      // ignore
    }
    client.sessionId = undefined;

    // 为“新会话”设置咨询预设选项，并直接触发 skill 启动
    try {
      const requestedCwd = typeof message.cwd === "string" ? message.cwd.trim() : "";
      if (requestedCwd) {
        if (!this.warnedCwdOverrides.has(ws)) {
          this.warnedCwdOverrides.add(ws);
          console.warn(
            `[WebSocketHandler] Ignored startConsultation.cwd=${requestedCwd}; server uses a fixed PROJECT_ROOT cwd bucket.`,
          );
        }
      }

      const consultationOptions = this.buildConsultationOptions(this.options);
      this.sessionManager.setSDKOptions(client, consultationOptions);
      this.sessionManager.sendMessage(
        client,
        [
          "[consultation:preset=consultative-selling]",
          "我想咨询皮肤问题。",
          "",
          "请直接使用 consultative-selling skill 开始咨询服务",          
        ].join("\n"),
        undefined,
      );
    } catch (error) {
      console.error("Failed to start consultation:", error);
      this.send(ws, {
        type: "error",
        error: "Failed to start consultation",
        code: "start_consultation_failed",
      });
    }
  }
}
