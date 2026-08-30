import { app, BrowserWindow, dialog, nativeTheme, protocol, session, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { createMediaFileResponse } from './media-protocol'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'zimu-media',
    privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true, corsEnabled: false }
  }
])

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#090d14',
    title: '字幕工坊',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f151f',
      symbolColor: '#dce6f4',
      height: 36
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'
  const configuredProxy = process.env.ZIMU_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy
  if (configuredProxy) {
    try {
      new URL(configuredProxy)
      await session.defaultSession.setProxy({ proxyRules: configuredProxy })
    } catch {
      console.warn('忽略无效的 ZIMU_PROXY/HTTPS_PROXY 配置')
    }
  }
  protocol.handle('zimu-media', async (request) => {
    try {
      const encoded = new URL(request.url).pathname.replace(/^\//, '')
      const filePath = Buffer.from(encoded, 'base64url').toString('utf8')
      return await createMediaFileResponse(filePath, request)
    } catch {
      return new Response('媒体文件不存在', { status: 404 })
    }
  })
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  void dialog.showErrorBox('字幕工坊启动失败', error instanceof Error ? error.message : String(error))
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
