import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ProjectInfo {
  id: string
  name: string
  path: string
}

export async function collectProjects(): Promise<ProjectInfo[]> {
  const projectsRoot = getProjectsRoot()
  if (!projectsRoot) {
    return []
  }

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

    let latestFilePath: string | null = null
    let latestMtime = -Infinity

    for (const file of jsonlFiles) {
      const filePath = path.join(projectDir, file.name)

      let statsResult
      try {
        statsResult = await stat(filePath)
      } catch {
        continue
      }

      if (statsResult.mtimeMs > latestMtime) {
        latestMtime = statsResult.mtimeMs
        latestFilePath = filePath
      }
    }

    if (!latestFilePath) {
      continue
    }

    const metadata = await extractSessionMetadata(latestFilePath)
    if (!metadata) {
      continue
    }

    const name = path.basename(metadata.cwd)
    projects.push({ id: entry.name, name, path: metadata.cwd })
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

  const projectDir = resolveProjectDir(projectsRoot, projectId)
  if (!projectDir) {
    return 'not_found'
  }

  const normalizedSessionId = sessionId.toLowerCase().endsWith('.jsonl')
    ? sessionId
    : `${sessionId}.jsonl`
  const sessionPath = path.join(projectDir, normalizedSessionId)

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

export function getProjectsRoot(): string | null {
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
