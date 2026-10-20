/**
 * Main-process bridge into the editor command layer.
 *
 * `executeEditorCommand` forwards a method call to the renderer's EditorAPI
 * (src/renderer/src/editor/api.ts) and resolves with its result. Any local
 * controller living in the main process (automation scripts, or a future
 * local MCP server) can drive the editor through this single entry point
 * without touching the UI. See docs/COMMANDS.md for the available methods.
 */
import { ipcMain, WebContents } from 'electron'

let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

ipcMain.on('bridge:result', (_e, msg: { id: number; ok: boolean; value?: unknown; error?: string }) => {
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.ok) p.resolve(msg.value)
  else p.reject(new Error(msg.error ?? 'Editor command failed.'))
})

export function executeEditorCommand(target: WebContents, method: string, ...args: unknown[]): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    target.send('bridge:invoke', { id, method, args })
  })
}
