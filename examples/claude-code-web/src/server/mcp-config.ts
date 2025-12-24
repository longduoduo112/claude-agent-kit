import fs from 'node:fs/promises'
import path from 'node:path'

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

type RawMcpConfig = {
  mcpServers?: Record<string, RawMcpServerConfig>
  allowedTools?: unknown
}

type RawMcpServerConfig =
  | RawMcpStdioConfig
  | RawMcpSseConfig
  | RawMcpHttpConfig

type RawMcpBaseConfig = {
  /**
   * 是否启用该 MCP Server。
   * - true/undefined：启用（默认）
   * - false：禁用（会被跳过）
   */
  enabled?: boolean
  /**
   * 仅当这些环境变量全部存在且非空时才启用该 MCP Server。
   * 主要用于像 Jina 这类必须提供 token 的服务，避免无 token 时长时间连接超时。
   */
  requiredEnv?: string[]
}

type RawMcpStdioConfig = {
  requiredEnv?: string[]
  type?: 'stdio'
  command?: string
  args?: string[]
  env?: Record<string, string>
}

type RawMcpSseConfig = {
  requiredEnv?: string[]
  type: 'sse'
  url?: string
  headers?: Record<string, string>
}

type RawMcpHttpConfig = {
  requiredEnv?: string[]
  type: 'http'
  url?: string
  headers?: Record<string, string>
}

export type LoadedMcpConfig = {
  mcpServers: Record<string, McpServerConfig>
  allowedTools: string[]
}

const DEFAULT_MCP_CONFIG: LoadedMcpConfig = {
  mcpServers: {},
  allowedTools: [],
}

const TEMPLATE_REGEX = /\$\{([^}]+)\}/g

function expandTemplate(value: string, env: Record<string, string | undefined>): string {
  return value.replace(TEMPLATE_REGEX, (_match, expression: string) => {
    const [rawKey, rawFallback] = expression.split(':-')
    const key = rawKey?.trim()
    const fallback = rawFallback ?? ''

    if (!key) {
      return fallback
    }

    const resolved = env[key] ?? process.env[key]
    if (resolved === undefined || resolved === null || resolved === '') {
      return fallback
    }

    return resolved
  })
}

function isLikelyPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return true
  }
  return (
    normalized === 'change-me' ||
    normalized.startsWith('replace-with') ||
    normalized.includes('your-jina-key') ||
    normalized.includes('your-api-key')
  )
}

function expandArgs(args: string[] | undefined, env: Record<string, string | undefined>): string[] | undefined {
  if (!Array.isArray(args) || args.length === 0) {
    return undefined
  }

  return args
    .map((arg) => expandTemplate(arg, env).trim())
    .filter((arg) => arg.length > 0)
}

function expandRecord(
  values: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!values) {
    return undefined
  }

  const entries = Object.entries(values)
    .map(([key, value]) => [key, expandTemplate(value, env)] as const)
    .filter(([key, value]) => Boolean(key) && value.length > 0)

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function normalizeStdioConfig(
  config: RawMcpStdioConfig,
  env: Record<string, string | undefined>,
): McpServerConfig | null {
  const command = config.command ? expandTemplate(config.command, env).trim() : ''
  if (!command) {
    console.warn('[MCP] Skipping stdio server missing command.')
    return null
  }

  const args = expandArgs(config.args, env)
  const envVars = expandRecord(config.env, env)

  return {
    type: 'stdio',
    command,
    ...(args ? { args } : {}),
    ...(envVars ? { env: envVars } : {}),
  }
}

function normalizeSseConfig(config: RawMcpSseConfig, env: Record<string, string | undefined>): McpServerConfig | null {
  const url = config.url ? expandTemplate(config.url, env).trim() : ''
  if (!url) {
    console.warn('[MCP] Skipping SSE server missing URL.')
    return null
  }

  const headers = expandRecord(config.headers, env)

  return {
    type: 'sse',
    url,
    ...(headers ? { headers } : {}),
  }
}

function normalizeHttpConfig(
  config: RawMcpHttpConfig,
  env: Record<string, string | undefined>,
): McpServerConfig | null {
  const url = config.url ? expandTemplate(config.url, env).trim() : ''
  if (!url) {
    console.warn('[MCP] Skipping HTTP server missing URL.')
    return null
  }

  const headers = expandRecord(config.headers, env)

  return {
    type: 'http',
    url,
    ...(headers ? { headers } : {}),
  }
}

function normalizeServerConfig(
  name: string,
  config: RawMcpServerConfig,
  env: Record<string, string | undefined>,
): McpServerConfig | null {
  if (!config || typeof config !== 'object') {
    console.warn('[MCP] Encountered invalid server configuration entry.')
    return null
  }

  const enabled = (config as RawMcpBaseConfig).enabled
  if (enabled === false) {
    console.warn(`[MCP] Skipping server '${name}' because it is disabled.`)
    return null
  }

  const requiredEnv = (config as RawMcpBaseConfig).requiredEnv
  if (Array.isArray(requiredEnv) && requiredEnv.length > 0) {
    const missing = requiredEnv
      .map((key) => key?.trim())
      .filter((key): key is string => Boolean(key))
      .filter((key) => {
        const resolved = env[key] ?? process.env[key]
        if (resolved === undefined || resolved === null) {
          return true
        }
        const stringValue = String(resolved)
        return isLikelyPlaceholder(stringValue)
      })

    if (missing.length > 0) {
      console.warn(
        `[MCP] Skipping server '${name}' because required env is missing: ${missing.join(', ')}`,
      )
      return null
    }
  }

  const type = config?.type ?? 'stdio'
  switch (type) {
    case 'stdio':
      return normalizeStdioConfig(config as RawMcpStdioConfig, env)
    case 'sse':
      return normalizeSseConfig(config as RawMcpSseConfig, env)
    case 'http':
      return normalizeHttpConfig(config as RawMcpHttpConfig, env)
    default:
      console.warn(`[MCP] Unsupported server type '${String((config as { type?: unknown }).type)}'.`)
      return null
  }
}

function normalizeAllowedTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)

  return normalized.length > 0 ? Array.from(new Set(normalized)) : []
}

function normalizeConfig(
  config: RawMcpConfig,
  env: Record<string, string | undefined>,
  configPath: string,
): LoadedMcpConfig {
  const servers: Record<string, McpServerConfig> = {}
  if (config.mcpServers && typeof config.mcpServers === 'object') {
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      const normalized = normalizeServerConfig(name, serverConfig, env)
      if (normalized) {
        servers[name] = normalized
      }
    }
  }

  const allowedTools = normalizeAllowedTools(config.allowedTools).filter((tool) => {
    if (!tool.startsWith('mcp__')) {
      return true
    }
    // mcp__<server>__<tool>
    const parts = tool.split('__')
    const serverName = parts[1]
    if (!serverName) {
      return false
    }
    return Boolean(servers[serverName])
  })

  return {
    mcpServers: servers,
    allowedTools,
  }
}

export async function loadMcpConfig(options: {
  projectRoot: string
  env?: Record<string, string | undefined>
}): Promise<LoadedMcpConfig> {
  const configPath = path.resolve(options.projectRoot, '.mcp.json')
  const env = options.env ?? {}

  let rawContents: string
  try {
    rawContents = await fs.readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[MCP] Failed to read ${configPath}:`, error)
    }
    return DEFAULT_MCP_CONFIG
  }

  let parsed: RawMcpConfig
  try {
    parsed = JSON.parse(rawContents) as RawMcpConfig
  } catch (error) {
    console.error(`[MCP] Invalid JSON in ${configPath}:`, error)
    return DEFAULT_MCP_CONFIG
  }

  return normalizeConfig(parsed, env, configPath)
}
