import type { ChatMessage, ChatMessagePart } from '@claude-agent-kit/messages'

export type ConsultationPreset = 'consultative-selling'

const CONSULTATIVE_SELLING_MARKER = '[consultation:preset=consultative-selling]'

function extractPlainTextFromParts(parts: ChatMessagePart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    const block = part.content
    if (block.type === 'text' && typeof block.text === 'string') {
      chunks.push(block.text)
    }
  }
  return chunks.join('')
}

export function detectConsultationPreset(
  messages: ChatMessage[],
): ConsultationPreset | null {
  for (const message of messages) {
    if (message.type !== 'user') {
      continue
    }

    const text = extractPlainTextFromParts(message.content).trim()
    if (text.startsWith(CONSULTATIVE_SELLING_MARKER)) {
      return 'consultative-selling'
    }

    // 仅以第一条 user 文本作为“会话类型”的判定依据，避免后续用户输入误触发
    return null
  }

  return null
}

function isUserToolResultOnly(message: ChatMessage): boolean {
  if (message.type !== 'user') {
    return false
  }
  if (message.content.length === 0) {
    return false
  }

  let hasToolResult = false
  for (const part of message.content) {
    const block = part.content
    if (block.type === 'tool_result') {
      hasToolResult = true
      continue
    }
    if (block.type === 'text' && (block.text ?? '').trim().length === 0) {
      continue
    }
    return false
  }

  return hasToolResult
}

function stripToolUseParts(message: ChatMessage): ChatMessage | null {
  if (message.type !== 'assistant') {
    return message
  }

  const nextParts = message.content.filter(
    (part) => part.content.type !== 'tool_use',
  )

  if (nextParts.length === 0) {
    return null
  }

  return {
    ...message,
    content: nextParts,
  }
}

export function filterMessagesForConsultation(
  messages: ChatMessage[],
  preset: ConsultationPreset,
): ChatMessage[] {
  if (preset !== 'consultative-selling') {
    return messages
  }

  const result: ChatMessage[] = []

  for (const message of messages) {
    // 隐藏启动指令：用户并未显式输入
    if (message.type === 'user') {
      const text = extractPlainTextFromParts(message.content).trim()
      if (text.startsWith(CONSULTATIVE_SELLING_MARKER)) {
        continue
      }
      // 隐藏 plan/skill 等工具确认的 tool_result 用户回写
      if (isUserToolResultOnly(message)) {
        continue
      }
    }

    const stripped = stripToolUseParts(message)
    if (!stripped) {
      continue
    }

    result.push(stripped)
  }

  return result
}
