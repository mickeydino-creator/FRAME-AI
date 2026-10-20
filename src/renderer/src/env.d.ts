import type { FrameAPI } from '../../shared/ipc'

declare global {
  interface Window {
    frameAPI: FrameAPI
  }
}

export {}
