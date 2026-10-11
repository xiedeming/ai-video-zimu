import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
vi.mock('./constants', () => ({ getAppPaths: () => ({ cache: 'unused' }) }))
import { spawnTracked } from './sidecars'

describe('sidecar cancellation', () => {
  it('terminates a child even when cancellation happened before spawning', async () => {
    const controller = new AbortController()
    controller.abort()
    const tracked = spawnTracked(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { signal: controller.signal })
    await expect(tracked.result).rejects.toHaveProperty('exitCode')
  })
})
