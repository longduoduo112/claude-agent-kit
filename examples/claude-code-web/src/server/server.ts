import { createServer as createHttpServer } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import type { ViteDevServer } from 'vite'
import { WebSocketServer } from 'ws'

import { Session, SimpleClaudeAgentSDKClient } from '@claude-agent-kit/server'
import type { SessionSDKOptions } from '@claude-agent-kit/server'
import { WebSocketHandler } from '@claude-agent-kit/websocket'
import { registerApiRoutes } from './api'
import { registerSkillUploadRoute } from './api/skills'
import { registerRoutes } from './routes'
import { loadMcpConfig } from './mcp-config'

export interface CreateServerOptions {
  root?: string
}

export async function createServer(options: CreateServerOptions = {}) {
  const root = options.root ?? process.cwd()
  const isProduction = process.env.NODE_ENV === 'production'
  const base = process.env.BASE ?? '/'
  const workspaceDir = process.env.WORKSPACE_DIR ?? path.resolve(root, 'agent')
  const workspacesDir = process.env.WORKSPACES_DIR ?? path.resolve(root, 'workspaces')
  await fs.mkdir(workspaceDir, { recursive: true })
  await fs.mkdir(workspacesDir, { recursive: true })
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.WORKSPACES_DIR = workspacesDir
  // 固定 Claude Code 的“主目录”（保存会话、debug、shell snapshot 等）。
  // 这能避免多进程/多轮对话时因 cwd 漂移而写入不同 `.claude` 根目录，进而导致 `--resume` 找不到会话、进程 code=1 退出。
  // 如需启用“每个项目目录各自维护 .claude”的行为，可在环境中显式设置 CLAUDE_HOME/CLAUDE_AGENT_HOME 覆盖这里的默认值。
  if (!process.env.CLAUDE_HOME) {
    process.env.CLAUDE_HOME = workspaceDir
  }
  if (!process.env.CLAUDE_AGENT_HOME) {
    process.env.CLAUDE_AGENT_HOME = process.env.CLAUDE_HOME
  }
  // Provide a stable project root env var for `.mcp.json` templating and tooling.
  // Some Claude Code components resolve `${PROJECT_ROOT}` using process.env only.
  if (!process.env.PROJECT_ROOT) {
    process.env.PROJECT_ROOT = root
  }

  const app = express()
  // Trust the first reverse proxy (e.g., Nginx/ingress) so rate limiting uses the real client IP
  app.set('trust proxy', 1)
  const httpServer = createHttpServer(app)
  const webSocketServer = new WebSocketServer({ server: httpServer })
  const sdkClient = new SimpleClaudeAgentSDKClient({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_URL,
    model: process.env.ANTHROPIC_MODEL,
  })
  const mcpConfig = await loadMcpConfig({
    projectRoot: root,
    env: {
      WORKSPACE_DIR: workspaceDir,
      WORKSPACES_DIR: workspacesDir,
      PROJECT_ROOT: root,
    },
  })

  const baseOptions = {
    thinkingLevel: 'default_on',
    // Windows 下某些启动方式可能导致子进程找不到 `node`（PATH 不完整），使用当前进程的 Node 路径可避免 `spawn node ENOENT`。
    executable: process.execPath,
    // 默认把 Claude 的工作目录设置为项目根目录（而不是 WORKSPACE_DIR）。
    // WORKSPACE_DIR 仅用于存放 `.claude` 相关数据（skills/会话/调试等），避免出现相对路径写入导致的 `agent/agent` 嵌套问题。
    cwd: root,
    // Avoid --dangerously-skip-permissions under root; default to plan mode
    permissionMode: 'plan',
    get systemPrompt() {
      return {
        type: 'preset',
        preset: 'claude_code',
        append: `\nToday's date is ${new Date().toDateString()}`,
      }
    },
  } as SessionSDKOptions

  if (Object.keys(mcpConfig.mcpServers).length > 0) {
    baseOptions.mcpServers = mcpConfig.mcpServers
  }

  if (mcpConfig.allowedTools.length > 0) {
    const templateSession = new Session(sdkClient)
    const defaultAllowedTools = templateSession.options.allowedTools ?? []
    baseOptions.allowedTools = Array.from(
      new Set([...defaultAllowedTools, ...mcpConfig.allowedTools]),
    )
  }

  const webSocketHandler = new WebSocketHandler(sdkClient, baseOptions)

  webSocketServer.on('connection', (ws) => {
    void webSocketHandler.onOpen(ws)

    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString()
      webSocketHandler.onMessage(ws, text).catch((error) => {
        console.error('Failed to handle WebSocket message', error)
      })
    })

    ws.on('close', () => {
      webSocketHandler.onClose(ws)
    })

    ws.on('error', (error) => {
      console.error('WebSocket client error', error)
    })
  })

  let templateHtml = ''
  let vite: ViteDevServer | undefined

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite')
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
      base,
    })
    app.use(vite.middlewares)
  } else {
    templateHtml = await fs.readFile(path.resolve(root, 'dist/client/index.html'), 'utf-8')
    const compression = (await import('compression')).default
    const sirv = (await import('sirv')).default
    app.use(compression())
    app.use(base, sirv(path.resolve(root, 'dist/client'), { extensions: [] }))
  }

  // Enable JSON body parsing for API routes
  app.use(express.json())

  registerApiRoutes(app, {
    sdkClient,
    defaultSessionOptions: webSocketHandler.options,
    workspaceDir,
    workspacesDir,
  })

  registerSkillUploadRoute(app, { workspaceDir })

  registerRoutes(app, {
    base,
    isProduction,
    root,
    templateHtml,
    vite,
  })

  return { app, vite, httpServer, webSocketServer }
}
