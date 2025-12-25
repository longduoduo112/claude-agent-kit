import type { Express, NextFunction, Request, Response } from 'express'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import rateLimit from 'express-rate-limit'

import type {
  IClaudeAgentSDKClient,
  SessionSDKOptions,
} from '@claude-agent-kit/server'

import { collectProjects, deleteProjectSession } from './projects'
import { collectSessionSummaries, readSessionDetails } from './project-sessions'
import { formatErrorMessage } from './errors'
import { collectCapabilitySummary } from './capabilities'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const rateLimiter = rateLimit({
  windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000), // default 15m
  max: Number(process.env.API_RATE_LIMIT_MAX || 300), // default 300 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
})

type RegisterApiRoutesOptions = {
  sdkClient?: IClaudeAgentSDKClient
  defaultSessionOptions?: SessionSDKOptions
  workspaceDir?: string
  workspacesDir?: string
}

export function registerApiRoutes(
  app: Express,
  options: RegisterApiRoutesOptions = {},
) {
  const { sdkClient, defaultSessionOptions, workspaceDir, workspacesDir } = options
  const hasAnthropicApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim())

  function buildFallbackCapabilities(message: string) {
    return {
      capabilities: {
        tools: [],
        mcpServers: [],
        slashCommands: [],
        skills: [],
        plugins: [],
        model: defaultSessionOptions?.model || 'unknown',
        cwd: defaultSessionOptions?.cwd ?? workspaceDir ?? null,
        permissionMode: defaultSessionOptions?.permissionMode || 'plan',
        apiKeySource: hasAnthropicApiKey ? 'env' : 'missing',
        localSkills: [],
      },
      warning: message,
    }
  }

  app.use(
    '/api',
    (req, res, next) => {
      res.set(corsHeaders)

      if (req.method === 'OPTIONS') {
        res.sendStatus(204)
        return
      }

      next()
    },
    rateLimiter,
  )

  app.get('/api/projects', async (_req, res) => {
    try {
      const projects = await collectProjects(workspaceDir)
      res.json({ projects, debug: true })
    } catch (error) {
      res
        .status(500)
        .json({ error: 'Failed to list projects', details: formatErrorMessage(error) })
    }
  })

  app.get('/api/projects/:projectId', async (req, res) => {
    const { projectId } = req.params

    try {
      const sessions = await collectSessionSummaries(projectId)

      if (sessions === null) {
        res.status(404).json({ error: `Project '${projectId}' not found` })
        return
      }

      res.json({ sessions })
    } catch (error) {
      res
        .status(500)
        .json({ error: 'Failed to list project sessions', details: formatErrorMessage(error) })
    }
  })

  app.get('/api/projects/:projectId/sessions/:sessionId', async (req, res) => {
    const { projectId, sessionId } = req.params

    try {
      const session = await readSessionDetails(projectId, sessionId)

      if (session === null) {
        res
          .status(404)
          .json({ error: `Session '${sessionId}' not found` })
        return
      }

      res.json(session)
    } catch (error) {
      res
        .status(500)
        .json({ error: 'Failed to read session details', details: formatErrorMessage(error) })
    }
  })

  app.delete('/api/projects/:projectId/sessions/:sessionId', async (req, res) => {
    const { projectId, sessionId } = req.params

    try {
      const result = await deleteProjectSession(projectId, sessionId)
      if (result === 'not_found') {
        res
          .status(404)
          .json({ error: `Session '${sessionId}' not found in project '${projectId}'` })
        return
      }

      res.status(204).end()
    } catch (error) {
      res
        .status(500)
        .json({ error: 'Failed to delete session', details: formatErrorMessage(error) })
    }
  })

  app.get('/api/capabilities', async (_req, res) => {
    if (!sdkClient || !hasAnthropicApiKey) {
      res.json(
        buildFallbackCapabilities(
          'Capability inspection is disabled (missing Anthropic-compatible API key).',
        ),
      )
      return
    }

    try {
      const capabilities = await collectCapabilitySummary(
        sdkClient,
        defaultSessionOptions,
        workspaceDir,
      )

      res.json({ capabilities })
    } catch (error) {
      // Surface details to logs to aid containerized deployments
      console.error('Capability inspection failed:', error)
      res.json(
        buildFallbackCapabilities(
          `Capability inspection failed: ${formatErrorMessage(error)}`,
        ),
      )
    }
  })

  app.get('/api/system-info', (_req, res) => {
    res.json({
      workspaceDir,
      workspacesDir,
      homeDir: os.homedir(),
      pathSeparator: path.sep,
    })
  })

  app.post('/api/create-directory', async (req, res) => {
    const { name: projectName } = req.body
    const workspacesRoot = workspacesDir ?? workspaceDir

    if (!workspacesRoot) {
      res.status(500).json({ error: 'Workspace directory not configured' })
      return
    }

    if (!projectName || typeof projectName !== 'string') {
      res.status(400).json({ error: 'Project name is required' })
      return
    }

    const trimmedProjectName = projectName.trim()
    // 避免创建与 WORKSPACE_DIR 同名的子目录（例如 workspaceDir 本身叫 agent，用户再创建 agent 会变成 agent/agent）。
    const reservedNames = new Set<string>([
      path.basename(workspacesRoot).toLowerCase(),
      ...(workspaceDir ? [path.basename(workspaceDir).toLowerCase()] : []),
      '.claude',
      '.git',
    ])
    if (reservedNames.has(trimmedProjectName.toLowerCase())) {
      res.status(400).json({
        error: `Invalid project name. '${trimmedProjectName}' is reserved.`,
      })
      return
    }

    // Validate project name: alphanumeric, spaces, hyphens, underscores only
    const validNamePattern = /^[\w][\w\s-]*$/
    if (!validNamePattern.test(trimmedProjectName)) {
      res.status(400).json({
        error: 'Invalid project name. Use only letters, numbers, spaces, hyphens, and underscores.'
      })
      return
    }

    // Prevent overly long names
    if (trimmedProjectName.length > 100) {
      res.status(400).json({ error: 'Project name too long (max 100 characters)' })
      return
    }

    try {
      // Construct full path server-side
      const fullPath = path.join(workspacesRoot, trimmedProjectName)

      // Security: Verify the resolved path is still within workspaceDir
      const resolvedWorkspace = path.resolve(workspacesRoot)
      const resolvedProject = path.resolve(fullPath)

      if (!resolvedProject.startsWith(resolvedWorkspace + path.sep) &&
        resolvedProject !== resolvedWorkspace) {
        res.status(403).json({
          error: 'Invalid project path. Path traversal detected.'
        })
        return
      }

      // Create directory
      await fs.mkdir(fullPath, { recursive: true })
      res.json({ success: true, path: fullPath })
    } catch (error) {
      res.status(500).json({
        error: 'Failed to create directory',
        details: formatErrorMessage(error),
      })
    }
  })

  app.delete('/api/projects/:name', async (req, res) => {
    const { name: projectName } = req.params
    const workspacesRoot = workspacesDir ?? workspaceDir

    if (!workspacesRoot) {
      res.status(500).json({ error: 'Workspace directory not configured' })
      return
    }

    if (!projectName) {
      res.status(400).json({ error: 'Project name is required' })
      return
    }

    try {
      // Construct full path
      const fullPath = path.join(workspacesRoot, projectName)

      // Security: Verify the path is within workspaceDir
      const resolvedWorkspace = path.resolve(workspacesRoot)
      const resolvedProject = path.resolve(fullPath)

      if (!resolvedProject.startsWith(resolvedWorkspace + path.sep) &&
        resolvedProject !== resolvedWorkspace) {
        res.status(403).json({
          error: 'Invalid project path. Path traversal detected.'
        })
        return
      }

      // Check if directory exists
      try {
        const stats = await fs.stat(fullPath)
        if (!stats.isDirectory()) {
          res.status(400).json({ error: 'Not a directory' })
          return
        }
      } catch (error) {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      // Delete directory recursively
      await fs.rm(fullPath, { recursive: true, force: true })
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({
        error: 'Failed to delete project',
        details: formatErrorMessage(error),
      })
    }
  })
}
