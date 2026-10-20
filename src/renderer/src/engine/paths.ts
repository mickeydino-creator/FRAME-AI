/** Join a project directory with a project-relative path using the directory's separator. */
export function joinPath(dir: string, rel: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const cleanDir = dir.replace(/[\\/]+$/, '')
  return `${cleanDir}${sep}${rel.replace(/[\\/]/g, sep)}`
}

export function mediaUrl(dir: string, rel: string): string {
  return window.frameAPI.media.toUrl(joinPath(dir, rel))
}
