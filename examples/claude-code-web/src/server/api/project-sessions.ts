import { readFile, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import {
  locateSessionFile,
  parseSessionMessagesFromJsonl,
} from '@claude-agent-kit/server'

import { getProjectsRoot } from './projects'

export interface SessionSummary {
  id: string
  prompt: string
  firstMessageAt: number
  lastMessageAt: number
}

export interface SessionDetails {
  id: string
  messages: SDKMessage[]
}

const SESSION_SUMMARY_LIMIT = Number(process.env.SESSION_LIST_LIMIT ?? 200)
const SESSION_SUMMARY_CACHE_TTL_MS = Number(
  process.env.SESSION_LIST_CACHE_TTL_MS ?? 2000,
)

type SessionSummaryCacheEntry = {
  expiresAt: number
  projectsRoot: string
  summaries: SessionSummary[]
}

let cachedSummaries: SessionSummaryCacheEntry | null = null
let lastIgnoredProjectIdLogAt = 0

export async function collectSessionSummaries(projectId: string): Promise<SessionSummary[] | null> {
  const projectsRoot = getProjectsRoot()
  if (!projectsRoot) {
    return []
  }

  // D1：所有会话共享同一个 cwd 桶（PROJECT_ROOT）。项目维度后续会移除，
  // 这里暂时忽略 projectId，返回全局最近会话列表，并打印节流日志避免旧 UI 误解。
  if (projectId) {
    const now = Date.now()
    if (now - lastIgnoredProjectIdLogAt > 10_000) {
      lastIgnoredProjectIdLogAt = now
      console.warn(
        `[api] Ignoring projectId='${projectId}': returning global recent sessions from the fixed PROJECT_ROOT bucket.`,
      )
    }
  }

  const summaries: SessionSummary[] = []

  if (
    cachedSummaries &&
    cachedSummaries.projectsRoot === projectsRoot &&
    cachedSummaries.expiresAt > Date.now()
  ) {
    return cachedSummaries.summaries
  }

  const recentFiles = await collectRecentSessionFiles(
    projectsRoot,
    SESSION_SUMMARY_LIMIT,
  )

  for (const file of recentFiles) {
    const summary = await buildSessionSummary(file.fileName, file.filePath)
    if (summary) {
      summaries.push(summary)
    }
  }

  summaries.sort((a, b) => b.lastMessageAt - a.lastMessageAt)

  cachedSummaries = {
    expiresAt: Date.now() + SESSION_SUMMARY_CACHE_TTL_MS,
    projectsRoot,
    summaries,
  }

  return summaries
}

export async function readSessionDetails(
  projectId: string,
  sessionId: string,
): Promise<SessionDetails | null> {
  const projectsRoot = getProjectsRoot()
  if (!projectsRoot) {
    return { id: sessionId, messages: [] }
  }

  const normalizedId = normalizeSessionId(sessionId)

  if (projectId) {
    const now = Date.now()
    if (now - lastIgnoredProjectIdLogAt > 10_000) {
      lastIgnoredProjectIdLogAt = now
      console.warn(
        `[api] Ignoring projectId='${projectId}': locating session details by sessionId across all projects buckets.`,
      )
    }
  }

  let filePath: string | null = null
  try {
    filePath = await locateSessionFile({ projectsRoot, sessionId: normalizedId })
  } catch {
    filePath = null
  }

  if (!filePath) {
    return null
  }

  let fileContent: string
  try {
    fileContent = await readFile(filePath, 'utf8')
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null
    }

    return { id: normalizedId, messages: [] }
  }

  const messages = parseSessionMessagesFromJsonl(fileContent)

  return { id: normalizedId, messages }
}

async function collectRecentSessionFiles(
  projectsRoot: string,
  limit: number,
): Promise<Array<{ fileName: string; filePath: string; mtimeMs: number }>> {
  let projectEntries: Dirent[]
  try {
    projectEntries = await readdir(projectsRoot, { withFileTypes: true })
  } catch (error) {
    if (isNotFoundError(error)) {
      return []
    }
    return []
  }

  const candidates: Array<{ fileName: string; filePath: string; mtimeMs: number }> = []

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue
    }

    const projectDir = path.join(projectsRoot, projectEntry.name)

    let entries: Dirent[]
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) {
        continue
      }

      const filePath = path.join(projectDir, entry.name)
      try {
        const stats = await stat(filePath)
        candidates.push({ fileName: entry.name, filePath, mtimeMs: stats.mtimeMs })
      } catch {
        continue
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates.slice(0, Math.max(0, limit))
}

function isCapabilityProbe(records: SDKMessage[]): boolean {
  if (records.length === 0) {
    return false
  }

  const first = records[0] as {
    type?: unknown
    operation?: unknown
    content?: unknown
  }

  if (first?.type !== 'queue-operation') {
    return false
  }

  if (first?.operation !== 'enqueue') {
    return false
  }

  const content = Array.isArray(first?.content) ? first.content : []
  const firstEntry = content[0] as { text?: unknown } | undefined
  return firstEntry?.text === 'claude-agent-sdk-capability-probe'
}

function isSidechainOnly(records: SDKMessage[]): boolean {
  if (records.length === 0) {
    return false
  }
  return records.every((record) => (record as { isSidechain?: unknown }).isSidechain === true)
}

function isIgnorableSession(records: SDKMessage[]): boolean {
  return isCapabilityProbe(records) || isSidechainOnly(records)
}

async function buildSessionSummary(fileName: string, filePath: string): Promise<SessionSummary | null> {
  let fileContent: string
  try {
    fileContent = await readFile(filePath, 'utf8')
  } catch {
    return null
  }

  const records = parseSessionMessagesFromJsonl(fileContent)
  if (records.length === 0) {
    return null
  }

  if (isIgnorableSession(records)) {
    return null
  }

  const firstRecord = records[0]
  const lastRecord = records[records.length - 1]

  const firstMessageAt =
    extractTimestamp((firstRecord as { firstMessageAt?: unknown }).firstMessageAt) ??
    extractTimestamp((firstRecord as { timestamp?: unknown }).timestamp)

  const lastMessageAt =
    extractTimestamp((lastRecord as { lastMessageAt?: unknown }).lastMessageAt) ??
    extractTimestamp((lastRecord as { timestamp?: unknown }).timestamp)

  if (firstMessageAt === null || lastMessageAt === null) {
    return null
  }

  const prompt =
    extractPrompt(firstRecord) ??
    extractPrompt((firstRecord as { message?: unknown }).message) ??
    ''

  const normalizedPrompt = normalizeSummaryPrompt(prompt)

  return {
    id: normalizeSessionId(fileName),
    prompt: normalizedPrompt,
    firstMessageAt,
    lastMessageAt,
  }
}

function extractTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const numeric = Number(value)
    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
      return numeric
    }

    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return null
}

function extractPrompt(source: unknown): string | null {
  if (!source || typeof source !== 'object') {
    return null
  }

  const record = source as Record<string, unknown>

  if (typeof record.prompt === 'string' && record.prompt.trim().length > 0) {
    return record.prompt.trim()
  }

  if (typeof record.text === 'string' && record.text.trim().length > 0) {
    return record.text.trim()
  }

  const message = record.message as Record<string, unknown> | undefined
  if (message) {
    const fromMessage = extractPrompt(message)
    if (fromMessage) {
      return fromMessage
    }
  }

  const content = record.content
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') {
        continue
      }

      const entry = item as Record<string, unknown>
      if (entry.type === 'text' && typeof entry.text === 'string') {
        const text = entry.text.trim()
        if (text.length > 0) {
          return text
        }
      }
    }
  }

  return null
}

function normalizeSessionId(value: string): string {
  return value.toLowerCase().endsWith('.jsonl') ? value.slice(0, -6) : value
}

function normalizeSummaryPrompt(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return trimmed
  }

  if (trimmed.startsWith('[consultation:preset=consultative-selling]')) {
    return '顾问式销售咨询'
  }

  return trimmed
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  )
}
