import { open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(content, 'utf8'); await file.sync() } finally { await file.close() }
    await rename(temporary, filePath)
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}
