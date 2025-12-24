import fs from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import monacoEditorPluginImport from 'vite-plugin-monaco-editor'
import { defineConfig } from 'vite'

function patchRmdirSyncForModernNode() {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(major) || major < 25) {
    return
  }

  const original = fs.rmdirSync
  fs.rmdirSync = ((targetPath: fs.PathLike, options?: unknown) => {
    if (options && typeof options === 'object' && 'recursive' in (options as Record<string, unknown>)) {
      const recursive = Boolean((options as Record<string, unknown>).recursive)
      fs.rmSync(targetPath, { recursive, force: true })
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (original as any)(targetPath, options as any)
  }) as typeof fs.rmdirSync
}

const monacoEditorPlugin =
  ((monacoEditorPluginImport as unknown as {
    default?: typeof monacoEditorPluginImport
  }).default ?? monacoEditorPluginImport) as typeof monacoEditorPluginImport

patchRmdirSyncForModernNode()

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    monacoEditorPlugin({
      languageWorkers: ['editorWorkerService', 'typescript', 'json', 'css', 'html'],
      globalAPI: true,
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/client'),
    },
  },
})
