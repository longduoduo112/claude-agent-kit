import type {
  SDKMessage,
  Options as SDKOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { AttachmentPayload } from "@claude-agent-kit/messages";
import type { IClaudeAgentSDKClient } from "./client";

export type ThinkingLevel = "off" | "default_on";

export interface ClaudeModelOption {
  value: string;
  displayName: string;
  description?: string;
}

export interface ClaudeConfig {
  models?: ClaudeModelOption[];
}

export interface SessionConfig {
  modelSetting?: string;
}

export interface ISessionClient {
  sessionId: string | undefined;
  sdkClient: IClaudeAgentSDKClient;
  receiveSessionMessage(event: string, message: OutcomingMessage): void;
}


export type OutcomingMessageType =
  | "message_added"
  | "messages_updated"
  | "session_state_changed";

export interface BaseOutcomingMessage {
  type: OutcomingMessageType;
  sessionId: string | null;
}

export interface MessageAddedOutcomingMessage extends BaseOutcomingMessage {
  type: "message_added";
  message: SDKMessage;
}


export interface MessagesUpdatedOutcomingMessage extends BaseOutcomingMessage {
  type: "messages_updated";
  messages: SDKMessage[];
}

export type SessionSDKOptions = SDKOptions & {
  thinkingLevel?: ThinkingLevel;
};

export type SessionStateSnapshot = {
  isBusy: boolean;
  isLoading: boolean;
  options: SessionSDKOptions;
};

export type SessionStateUpdate = Partial<SessionStateSnapshot>;

export interface SessionStateChangedOutcomingMessage extends BaseOutcomingMessage {
  type: "session_state_changed";
  sessionState: SessionStateUpdate;
}

export type OutcomingMessage =
  | MessageAddedOutcomingMessage
  | MessagesUpdatedOutcomingMessage
  | SessionStateChangedOutcomingMessage;


interface BaseIncomingMessage {
  type: "chat" | "setSDKOptions" | "resume" | "toolResult" | "startConsultation";
  sessionId?: string | null;
}

export interface ChatIncomingMessage extends BaseIncomingMessage {
  type: "chat";
  content: string;
  attachments?: AttachmentPayload[];
  newConversation?: boolean;
}

export interface SetSDKOptionsIncomingMessage extends BaseIncomingMessage {
  type: "setSDKOptions";
  options: Partial<SessionSDKOptions>
}

export interface ResumeSessionIncomingMessage extends BaseIncomingMessage {
  type: "resume";
  sessionId: string;
}

export interface ToolResultIncomingMessage extends BaseIncomingMessage {
  type: "toolResult";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface StartConsultationIncomingMessage extends BaseIncomingMessage {
  type: "startConsultation";
  /** 预设咨询类型（目前仅支持 consultative-selling） */
  preset: "consultative-selling" | (string & {});
  /** 可选：用于设置会话 CWD（通常是项目路径） */
  cwd?: string | null;
  /** 可选：用于前端/日志关联（当前实现不强依赖） */
  projectId?: string | null;
}

export type IncomingMessage =
  | ChatIncomingMessage
  | SetSDKOptionsIncomingMessage
  | ResumeSessionIncomingMessage
  | ToolResultIncomingMessage
  | StartConsultationIncomingMessage;
