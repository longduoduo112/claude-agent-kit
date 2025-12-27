import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { locateSessionFile, normalizeSessionId } from '@claude-agent-kit/server'

export interface ProjectInfo {
  id: string
  name: string
  path: string
}

export async function collectProjects(workspaceDir?: string): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = []
  const seenPaths = new Set<string>()

  // 1. Scan global projects root
  const globalRoot = getProjectsRoot(workspaceDir)
  if (globalRoot) {
    const globalProjects = await scanProjectsDirectory(globalRoot, workspaceDir)
    for (const p of globalProjects) {
      if (!seenPaths.has(p.path)) {
        projects.push(p)
        seenPaths.add(p.path)
      }
    }
  }

  // 2. Scan sub-workspaces if workspaceDir is provided
  // This detects projects like agent/Agent3 which have their own .claude/projects
  if (workspaceDir) {
    try {
      const subdirs = await readdir(workspaceDir, { withFileTypes: true })
      for (const subdir of subdirs) {
        if (!subdir.isDirectory() || subdir.name.startsWith('.')) {
          continue
        }

        const subdirPath = path.join(workspaceDir, subdir.name)
        const claudeProjectsDir = path.join(subdirPath, '.claude', 'projects')

        try {
          const stats = await stat(claudeProjectsDir)
          if (stats.isDirectory()) {
            const subProjects = await scanProjectsDirectory(claudeProjectsDir, workspaceDir)
            for (const p of subProjects) {
              if (!seenPaths.has(p.path)) {
                projects.push(p)
                seenPaths.add(p.path)
              }
            }
          }
        } catch {
          // Ignore if .claude/projects doesn't exist or isn't accessible
        }
      }
    } catch {
      // Ignore if workspaceDir cannot be read
    }
  }

  return projects
}

async function isExistingDirectory(candidate: string): Promise<boolean> {
  try {
    const stats = await stat(candidate)
    return stats.isDirectory()
  } catch {
    return false
  }
}

async function resolveExistingProjectCwd(cwd: string, workspaceDir?: string): Promise<string> {
  if (await isExistingDirectory(cwd)) {
    return cwd
  }

  const baseName = path.basename(cwd)
  const candidates: string[] = []

  const workspacesDir = process.env.WORKSPACES_DIR?.trim()
  if (workspacesDir) {
    candidates.push(path.resolve(workspacesDir, baseName))
  }

  const projectRoot = process.env.PROJECT_ROOT?.trim()
  if (projectRoot) {
    candidates.push(path.resolve(projectRoot, baseName))
  }

  if (workspaceDir) {
    candidates.push(path.resolve(workspaceDir, '..', baseName))
  }

  for (const candidate of candidates) {
    if (await isExistingDirectory(candidate)) {
      return candidate
    }
  }

  return cwd
}

async function scanProjectsDirectory(projectsRoot: string, workspaceDir?: string): Promise<ProjectInfo[]> {
  let rootEntries: Dirent[]
  try {
    rootEntries = await readdir(projectsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const projects: ProjectInfo[] = []

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) {
      continue
    }

    const projectDir = path.join(projectsRoot, entry.name)

    let candidateFiles: Dirent[]
    try {
      candidateFiles = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }

    const jsonlFiles = candidateFiles.filter(
      (file) => file.isFile() && file.name.toLowerCase().endsWith('.jsonl'),
    )

    if (jsonlFiles.length === 0) {
      continue
    }

    // Collect all files with their mtimes
    const filesWithMtime: { path: string; mtime: number }[] = []

    for (const file of jsonlFiles) {
      const filePath = path.join(projectDir, file.name)
      try {
        const stats = await stat(filePath)
        filesWithMtime.push({ path: filePath, mtime: stats.mtimeMs })
      } catch {
        continue
      }
    }

    // Sort by mtime descending (newest first)
    filesWithMtime.sort((a, b) => b.mtime - a.mtime)

    // Try to find valid metadata in the most recent files
    let foundMetadata: { cwd: string } | null = null

    for (const file of filesWithMtime.slice(0, 10)) {
      const metadata = await extractSessionMetadata(file.path)
      if (metadata) {
        foundMetadata = metadata
        break
      }
    }

    if (!foundMetadata) {
      continue
    }

    const resolvedCwd = await resolveExistingProjectCwd(foundMetadata.cwd, workspaceDir)
    const name = path.basename(resolvedCwd)
    projects.push({ id: entry.name, name, path: resolvedCwd })
  }

  return projects
}

export async function deleteProjectSession(
  projectId: string,
  sessionId: string,
): Promise<'deleted' | 'not_found'> {
  const projectsRoot = getProjectsRoot()
  if (!projectsRoot) {
    return 'not_found'
  }

  // D1：固定 cwd 桶后，session 可能分布在多个 projects/<bucket> 目录中。
  // 删除时按 sessionId 全局定位文件，忽略 projectId（后续项目维度会移除）。
  if (projectId) {
    console.warn(
      `[api] Ignoring projectId='${projectId}' for delete: locating session file by sessionId across all buckets.`,
    )
  }

  const normalized = normalizeSessionId(sessionId)
  const sessionPath = await locateSessionFile({ projectsRoot, sessionId: normalized })
  if (!sessionPath) {
    return 'not_found'
  }

  try {
    await unlink(sessionPath)
    return 'deleted'
  } catch (error) {
    if (isNotFoundError(error)) {
      return 'not_found'
    }
    throw error
  }
}

export function getProjectsRoot(workspaceDir?: string): string | null {
  const envWorkspaceDir = process.env.WORKSPACE_DIR?.trim()
  const effectiveWorkspaceDir = workspaceDir || envWorkspaceDir

  if (effectiveWorkspaceDir && effectiveWorkspaceDir.length > 0) {
    return path.resolve(effectiveWorkspaceDir, '.claude', 'projects')
  }

  const homeDir = os.homedir()
  if (!homeDir || homeDir.trim().length === 0) {
    return null
  }

  return path.join(homeDir, '.claude', 'projects')
}

async function extractSessionMetadata(
  filePath: string,
): Promise<{ cwd: string } | null> {
  let fileContent: string

  try {
    fileContent = await readFile(filePath, 'utf8')
  } catch {
    return null
  }

  if (fileContent.length === 0) {
    return null
  }

  const lines = fileContent.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed.replace(/^\uFEFF/, ''))
    } catch {
      continue
    }

    const cwd = (parsed as { cwd?: unknown } | undefined)?.cwd
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      return { cwd: cwd.trim() }
    }
  }

  return null
}

function resolveProjectDir(
  projectsRoot: string,
  projectId: string,
): string | null {
  const resolvedRoot = path.resolve(projectsRoot)
  const resolvedProject = path.resolve(projectsRoot, projectId)
  if (!resolvedProject.startsWith(resolvedRoot)) {
    return null
  }
  return resolvedProject
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT',
  )
}
