import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildUserMessageContent,
  type AttachmentPayload,
  type UsageSummary,
} from "@claude-agent-kit/messages";
import type {
  ClaudeConfig,
  SessionConfig,
  IClaudeAgentSDKClient,
  ISessionClient,
  OutcomingMessage,
  SessionStateUpdate,
  SessionStateSnapshot,
  SessionSDKOptions,
} from "../types";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKUserMessage,
  Options as SDKOptions,
} from "@anthropic-ai/claude-agent-sdk";

const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  "Task",
  "Bash",
  "Glob",
  "Grep",
  "LS",
  "ExitPlanMode",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "TodoWrite",
  "BashOutput",
  "KillBash",
  "Skill",
];

const DEFAULT_SESSION_OPTIONS: SessionSDKOptions = {
  maxTurns: 100,
  allowedTools: [...DEFAULT_ALLOWED_TOOLS],
  mcpServers: {},
  hooks: {},
  thinkingLevel: "default_on",
  settingSources: ["user", "project", "local"],
};

function normalizeWorkspacePath(value?: string | null): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed ? trimmed : undefined;
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

async function ensureCwdAliasExists(expectedCwd: string, actualCwd: string): Promise<void> {
  if (!expectedCwd || !actualCwd) {
    return;
  }

  if (isExistingDirectory(expectedCwd)) {
    return;
  }

  if (!isExistingDirectory(actualCwd)) {
    return;
  }

  const parentDir = path.dirname(expectedCwd);
  try {
    fs.mkdirSync(parentDir, { recursive: true });
  } catch {
    // ignore
  }

  try {
    // Windows 下用 junction 避免管理员权限；其他平台用 dir 类型即可。
    const linkType: fs.symlink.Type | undefined =
      process.platform === "win32" ? "junction" : "dir";
    await fs.promises.symlink(actualCwd, expectedCwd, linkType);
  } catch {
    // ignore if cannot create (already exists, permissions, etc.)
  }
}

function resolveExistingWorkspaceCwd(cwd: string): string {
  if (isExistingDirectory(cwd)) {
    return cwd;
  }

  const baseName = path.basename(cwd);
  const candidates: string[] = [];

  const workspacesDir = normalizeWorkspacePath(process.env.WORKSPACES_DIR ?? null);
  if (workspacesDir) {
    candidates.push(path.resolve(workspacesDir, baseName));
  }

  const projectRoot = normalizeWorkspacePath(process.env.PROJECT_ROOT ?? null);
  if (projectRoot) {
    candidates.push(path.resolve(projectRoot, baseName));
  }

  const workspaceDir = normalizeWorkspacePath(process.env.WORKSPACE_DIR ?? null);
  if (workspaceDir) {
    candidates.push(path.resolve(workspaceDir, "..", baseName));
  }

  for (const candidate of candidates) {
    if (isExistingDirectory(candidate)) {
      return candidate;
    }
  }

  return cwd;
}

function createDefaultOptions(workspacePath?: string | null): SessionSDKOptions {
  const cwd = normalizeWorkspacePath(workspacePath);
  return {
    ...DEFAULT_SESSION_OPTIONS,
    allowedTools: DEFAULT_SESSION_OPTIONS.allowedTools
      ? [...DEFAULT_SESSION_OPTIONS.allowedTools]
      : undefined,
    mcpServers: {
      ...(DEFAULT_SESSION_OPTIONS.mcpServers ?? {}),
    },
    hooks: {
      ...(DEFAULT_SESSION_OPTIONS.hooks ?? {}),
    },
    ...(cwd ? { cwd } : {}),
  };
}

function extractToolUseBlocks(message: SDKMessage): Array<{ id: string; name: string }> {
  if (!message || typeof message !== "object") {
    return [];
  }

  if ((message as { type?: unknown }).type !== "assistant") {
    return [];
  }

  const assistant = message as unknown as {
    message?: { content?: Array<{ type?: unknown; id?: unknown; name?: unknown }> };
  };

  const content = Array.isArray(assistant.message?.content) ? assistant.message?.content : [];
  const blocks: Array<{ id: string; name: string }> = [];

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type !== "tool_use") {
      continue;
    }
    const id = typeof block.id === "string" ? block.id : "";
    const name = typeof block.name === "string" ? block.name : "";
    if (id && name) {
      blocks.push({ id, name });
    }
  }

  return blocks;
}

function messageHasToolResult(message: SDKMessage, toolUseId: string): { found: boolean; approved: boolean } {
  if (!message || typeof message !== "object") {
    return { found: false, approved: false };
  }

  if ((message as { type?: unknown }).type !== "user") {
    return { found: false, approved: false };
  }

  const user = message as unknown as {
    message?: { content?: Array<{ type?: unknown; tool_use_id?: unknown; is_error?: unknown }> };
  };

  const content = Array.isArray(user.message?.content) ? user.message?.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type !== "tool_result") {
      continue;
    }
    if (block.tool_use_id !== toolUseId) {
      continue;
    }
    const isError = block.is_error === true;
    return { found: true, approved: !isError };
  }

  return { found: false, approved: false };
}

function findLatestPendingExitPlanModeToolUseId(messages: SDKMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }

    const toolUses = extractToolUseBlocks(message);
    const exitTool = toolUses.find((tool) => tool.name === "ExitPlanMode");
    if (!exitTool) {
      continue;
    }

    // 检查在该 tool_use 之后是否已经有“成功”的 tool_result（用户已批准）。
    for (let j = i + 1; j < messages.length; j += 1) {
      const result = messageHasToolResult(messages[j]!, exitTool.id);
      if (!result.found) {
        continue;
      }
      if (result.approved) {
        return null;
      }
      // 如果用户此前拒绝过（is_error=true），允许重新提交批准。
      return exitTool.id;
    }

    // 还没有收到 tool_result，视为待确认。
    return exitTool.id;
  }

  return null;
}


export class Session {
  sessionId: string | null = null; // Claude session ID
  options: SessionSDKOptions = createDefaultOptions();
  usageSummary: UsageSummary | undefined;
  claudeConfig: ClaudeConfig | undefined;
  modelSelection: string | undefined;
  config: SessionConfig | undefined;
  lastModifiedTime = Date.now();
  summary: string | undefined;
  error: Error | string | undefined;

  private sdkClient: IClaudeAgentSDKClient;
  private queryPromise: Promise<void> | null = null;
  private loadingPromise: Promise<void> | null = null;
  private abortController: AbortController | undefined = undefined;
  private busyState: boolean = false;
  private loadingState: boolean = false;
  private messageList: SDKMessage[] = [];
  private lastResultMessage: SDKMessage | null = null;
  private isLoaded = false;
  private clients: Set<ISessionClient> = new Set();
  private pendingStateUpdate: SessionStateUpdate | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 50;

  constructor(sdkClient: IClaudeAgentSDKClient) {
    this.sdkClient = sdkClient;
  }

  get isBusy(): boolean {
    return this.busyState;
  }

  private setBusyState(state: boolean): void {
    if (this.busyState === state) {
      return;
    }
    this.busyState = state;
    this.emitSessionStateChange({ isBusy: state });
  }

  get isLoading(): boolean {
    return this.loadingState;
  }

  private setLoadingState(state: boolean): void {
    if (this.loadingState === state) {
      return;
    }
    this.loadingState = state;
    this.emitSessionStateChange({ isLoading: state });
  }

  setSDKOptions(
    options: Partial<SessionSDKOptions>,
  ): void {
    const hasExplicitCwd = Object.prototype.hasOwnProperty.call(options, "cwd");
    let normalizedCwd = hasExplicitCwd ? normalizeWorkspacePath(options.cwd ?? undefined) : undefined;
    if (normalizedCwd) {
      normalizedCwd = resolveExistingWorkspaceCwd(normalizedCwd);
    }

    const normalized: Partial<SessionSDKOptions> = {
      ...options,
      ...(hasExplicitCwd ? { cwd: normalizedCwd } : {}),
    };

    const baseOptions = createDefaultOptions(hasExplicitCwd ? normalizedCwd : this.options.cwd);
    const nextOptions: SessionSDKOptions = {
      ...baseOptions,
      ...this.options,
      ...normalized,
    };

    if (hasExplicitCwd && !normalizedCwd) {
      delete (nextOptions as Record<string, unknown>).cwd;
    }

    this.options = nextOptions;
    this.emitSessionStateChange({ options: this.buildEffectiveOptions() });
  }

  private buildEffectiveOptions(): SessionSDKOptions {
    return {
      ...createDefaultOptions(this.options.cwd),
      ...this.options,
    };
  }

  get messages(): SDKMessage[] {
    return this.messageList;
  }

  findWorkspacePathFromMessages(messages: SDKMessage[]): string | undefined {
    const cwdMessage = messages.find(msg => (msg as SDKSystemMessage).cwd) as SDKSystemMessage | undefined;
    return cwdMessage?.cwd || undefined;
  }

  private setMessages(messages: SDKMessage[]): void {
    this.messageList = messages;

    if (!this.options.cwd) {
      const detectedWorkspace = this.findWorkspacePathFromMessages(messages);
      if (detectedWorkspace) {
        this.setSDKOptions({ cwd: detectedWorkspace });
      }
    }

    console.log(
      `[Session] setMessages for ${this.sessionId ?? "pending"} count=${messages.length} (wasLoaded=${this.isLoaded})`,
    );
    this.notifyClients("messagesUpdated", {
      type: "messages_updated",
      sessionId: this.sessionId,
      messages,
    });
  }

  private syncClientSessionIds(): void {
    const sessionId = this.sessionId ?? undefined;
    this.clients.forEach((client) => {
      client.sessionId = sessionId;
    });
  }

  private updateSessionId(sessionId: string | null | undefined): void {
    const normalized = sessionId ?? null;
    if (this.sessionId === normalized) {
      return;
    }
    this.sessionId = normalized;
    this.syncClientSessionIds();
  }

  interrupt(): void {
    this.abortController?.abort();
    this.setBusyState(false);
  }

  /**
   * 发送 tool_result 给 Claude Code（用于 ExitPlanMode / AskUserQuestion 等需要用户确认的工具）。
   * 注意：这会像普通消息一样触发一次新的 queryStream。
   */
  async sendToolResult(toolUseId: string, content: string, isError: boolean): Promise<void> {
    if (this.queryPromise) {
      await this.queryPromise;
    }

    const trimmedId = typeof toolUseId === "string" ? toolUseId.trim() : "";
    if (!trimmedId) {
      throw new Error("toolUseId is required");
    }

    const userMessage: SDKUserMessage = {
      type: "user",
      uuid: randomUUID(),
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: trimmedId,
            content,
            is_error: isError,
          },
        ],
      },
    };

    await this.startQueryWithUserMessage(userMessage);
  }


  // Subscribe a WebSocket client to this session
  subscribe(client: ISessionClient) {
    if (this.clients.has(client)) {
      return;
    }
    this.clients.add(client);
    client.sessionId = this.sessionId ?? undefined;
    const sessionState = this.getSessionStateSnapshot();
    console.log(
      `[Session] Client subscribed to ${this.sessionId ?? "uninitialized"} (messages=${this.messageList.length}, loaded=${this.isLoaded})`,
    );
    client.receiveSessionMessage(
      "sessionStateChanged",
      this.createSessionStateMessage(sessionState),
    );

    // When a client attaches to an already loaded session, immediately send the
    // current transcript so switching sessions always repopulates the UI.
    if (this.isLoaded) {
      client.receiveSessionMessage("messagesUpdated", {
        type: "messages_updated",
        sessionId: this.sessionId,
        messages: [...this.messageList],
      });
      console.log(`[Session] Sent cached transcript to client for ${this.sessionId}: ${this.messageList.length} messages`);
    }
  }

  unsubscribe(client: ISessionClient) {
    this.clients.delete(client);
  }

  hasClient(client: ISessionClient): boolean {
    return this.clients.has(client);
  }

  notifyClients(event: string, message: OutcomingMessage) {
    this.clients.forEach((client: ISessionClient) => {
      if (!client) {
        return;
      }
      client.receiveSessionMessage(event, message);
    });
  }

  addNewMessage(message: SDKMessage): void {
    this.messageList.push(message);
    this.notifyClients("messageAdded", {
      type: "message_added",
      sessionId: this.sessionId,
      message,
    });
  }

  loadFromServer(sessionId?: string): Promise<void> | undefined {
    const targetSessionId = sessionId ?? this.sessionId ?? undefined;
    if (!targetSessionId) {
      return undefined;
    }

    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.updateSessionId(targetSessionId);
    this.setLoadingState(true);
    this.error = undefined;

    this.loadingPromise = (async () => {
      try {
        const { messages } = await this.sdkClient.loadMessages(targetSessionId);
        console.log(`[Session] loadFromServer(${targetSessionId}) returned ${messages.length} messages`);
        if (messages.length === 0) {
          console.log(`[Session] 🔥 SKIPPING setMessages for empty new session ${targetSessionId}`);
          // Don't notify clients about empty message list for brand new sessions
          // This prevents clearing the UI when a new session hasn't written to disk yet
          this.messageList = [];
          this.summary = undefined;
          this.lastModifiedTime = Date.now();
          this.setBusyState(false);
          return;
        }

        this.summary = undefined;
        this.setMessages(messages);
        this.setBusyState(false);
        this.isLoaded = true;
      } catch (error) {
        console.error(`Failed to load session '${targetSessionId}':`, error);
        this.error = error instanceof Error ? error : String(error);
      } finally {
        this.setLoadingState(false);
        this.loadingPromise = null;
        console.log(`[Session] Finished loading ${targetSessionId}`);
      }
    })();

    return this.loadingPromise;
  }

  async resumeFrom(sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }

    console.log(
      `[Session] resumeFrom ${sessionId} (current=${this.sessionId ?? "none"}, loaded=${this.isLoaded})`,
    );

    if (this.sessionId === sessionId && this.isLoaded) {
      console.log(`[Session] resumeFrom short-circuited for ${sessionId} (already loaded)`);
      return;
    }

    await this.loadFromServer(sessionId);
    console.log(`[Session] resumeFrom finished loading ${sessionId}`);
  }

  private async startQueryWithUserMessage(userMessage: SDKUserMessage, summaryText?: string): Promise<void> {
    this.abortController = new AbortController();

    async function* generateMessages() {
      yield userMessage;
    }

    this.addNewMessage(userMessage);

    // Seed the session summary with the user's first prompt if needed.
    if (!this.summary && summaryText) {
      this.summary = summaryText;
    }

    this.lastModifiedTime = Date.now();
    this.setBusyState(true);

    this.lastResultMessage = null;
    this.queryPromise = (async () => {
      try {
        const { thinkingLevel: _thinkingLevel, ...effectiveOptions } = this.buildEffectiveOptions();
        const options: SDKOptions = {
          ...effectiveOptions,
          abortController: this.abortController,
        };

        // Use resume for multi-turn, continue for first message
        if (this.sessionId) {
          options.resume = this.sessionId;

          // Claude Code 的 session 持久化是“按项目（cwd）分桶”的：如果 cwd 变了，即便 sessionId 一样也可能找不到会话。
          // 对于已存在会话，优先使用 transcript 中记录的 cwd，并在 cwd 已迁移时自动创建一个目录别名（junction/symlink），
          // 避免出现 “No conversation found with session ID ...” 进而 code=1 退出。
          const transcriptCwdRaw = this.findWorkspacePathFromMessages(this.messageList);
          const transcriptCwd = normalizeWorkspacePath(transcriptCwdRaw);
          if (transcriptCwd) {
            const resolved = resolveExistingWorkspaceCwd(transcriptCwd);
            if (resolved !== transcriptCwd) {
              await ensureCwdAliasExists(transcriptCwd, resolved);
            }

            if (isExistingDirectory(transcriptCwd)) {
              options.cwd = transcriptCwd;
              if (this.options.cwd !== transcriptCwd) {
                this.options = {
                  ...this.options,
                  cwd: transcriptCwd,
                };
              }
            }
          }
        }

        for await (const message of this.sdkClient.queryStream(
          generateMessages(),
          options
        )) {
          console.log(message);
          this.processIncomingMessage(message);
        }
      } catch (error) {
        if (shouldSuppressExitErrorAfterResult(error, this.lastResultMessage)) {
          // 不额外标记 session error；UI 里已经有 result message（包含错误原因）
        } else {
          console.error(`Error in session ${this.sessionId}:`, enrichSdkErrorForLogs(error));
          this.error = error instanceof Error ? error : String(error);
        }
      } finally {
        this.queryPromise = null;
        this.setBusyState(false);
      }
    })();

    await this.queryPromise;
    this.lastModifiedTime = Date.now();
  }

  // Process a single user message
  async send(
    prompt: string,
    attachments: AttachmentPayload[] | undefined
  ): Promise<void> {
    if (this.queryPromise) {
      // Queue is busy, wait for it
      await this.queryPromise;
    }

    // 在计划模式下，用户常用“执行/运行”等自然语言来表示批准方案；如果检测到待确认的 ExitPlanMode，
    // 则将该输入转换为 tool_result（避免 Claude Code 挂起或退出）。
    const normalizedPrompt = prompt.trim();
    if (
      normalizedPrompt === "执行" ||
      normalizedPrompt === "运行" ||
      normalizedPrompt.toLowerCase() === "execute" ||
      normalizedPrompt.toLowerCase() === "run"
    ) {
      const pendingExitId = findLatestPendingExitPlanModeToolUseId(this.messageList);
      if (pendingExitId) {
        await this.sendToolResult(pendingExitId, "User approved the plan", false);
        return;
      }
    }

    // Build the synthetic user message that will kick off the stream.
    const userMessage: SDKUserMessage = {
      type: "user",
      uuid: randomUUID(),
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: buildUserMessageContent(prompt, attachments),
      },
    };

    await this.startQueryWithUserMessage(userMessage, normalizedPrompt);
  }


  processIncomingMessage(message: SDKMessage): void {
    console.log("Received message:", message);

    if (message.session_id) {
      this.updateSessionId(message.session_id);
    }

    if (message.type === "result") {
      this.lastResultMessage = message;
    }

    this.addNewMessage(message);

    const rawTimestamp = (message as { timestamp?: unknown }).timestamp;
    const extracted = extractTimestamp(rawTimestamp);
    this.lastModifiedTime = extracted ?? Date.now();

    // Update high level state derived from system/result messages.
    if (message.type === "system") {
      if (message.subtype === "init") {
        this.setBusyState(true);
      }
    } else if (message.type === "result") {
      this.setBusyState(false);
    }
  }
  private getSessionStateSnapshot(): SessionStateSnapshot {
    return {
      isBusy: this.busyState,
      isLoading: this.loadingState,
      options: this.buildEffectiveOptions(),
    };
  }

  private createSessionStateMessage(update: SessionStateUpdate): OutcomingMessage {
    return {
      type: "session_state_changed",
      sessionId: this.sessionId,
      sessionState: update,
    };
  }

  private emitSessionStateChange(update: SessionStateUpdate): void {
    if (!update || Object.keys(update).length === 0) {
      return;
    }

    // Accumulate updates
    this.pendingStateUpdate = {
      ...this.pendingStateUpdate,
      ...update,
    };

    // Clear existing timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Set new timer to batch updates
    this.debounceTimer = setTimeout(() => {
      if (this.pendingStateUpdate) {
        this.notifyClients("sessionStateChanged", this.createSessionStateMessage(this.pendingStateUpdate));
        this.pendingStateUpdate = null;
      }
      this.debounceTimer = null;
    }, this.DEBOUNCE_MS);
  }
}

function extractTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}

function enrichSdkErrorForLogs(error: unknown): unknown {
  if (error instanceof Error) {
    const record = error as unknown as Record<string, unknown>;
    const stderrRaw = record.stderr;
    const stdoutRaw = record.stdout;

    const stderr = truncateText(asText(stderrRaw), 4000);
    const stdout = truncateText(asText(stdoutRaw), 2000);

    const enriched: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    const cause = (error as unknown as { cause?: unknown }).cause;
    if (cause) {
      enriched.cause = enrichSdkErrorForLogs(cause);
    }

    return {
      ...record,
      ...enriched,
      ...(stderr ? { stderr } : {}),
      ...(stdout ? { stdout } : {}),
    };
  }

  if (!error || typeof error !== "object") {
    return error;
  }

  const record = error as Record<string, unknown>;
  const stderrRaw = record.stderr;
  const stdoutRaw = record.stdout;

  const stderr = truncateText(asText(stderrRaw), 4000);
  const stdout = truncateText(asText(stdoutRaw), 2000);

  return {
    ...record,
    ...(stderr ? { stderr } : {}),
    ...(stdout ? { stdout } : {}),
  };
}

function asText(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    try {
      return new TextDecoder().decode(value);
    } catch {
      return null;
    }
  }
  return null;
}

function truncateText(value: string | null, maxChars: number): string | null {
  if (!value) {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n…(truncated)`;
}

function shouldSuppressExitErrorAfterResult(error: unknown, lastResult: SDKMessage | null): boolean {
  if (!lastResult || lastResult.type !== "result") {
    return false;
  }

  const record = lastResult as { is_error?: unknown };
  const isErrorResult = record.is_error === true;
  if (!isErrorResult) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("Claude Code process exited with code 1");
}
