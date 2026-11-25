const { app, BrowserWindow, dialog } = require('electron')
const { createReadStream, existsSync } = require('node:fs')
const { stat } = require('node:fs/promises')
const { createServer } = require('node:http')
const path = require('node:path')

// A stable loopback origin keeps the Chromium SQLite files across launches.
const origin = 'http://127.0.0.1:41876'
const buildDir = path.resolve(__dirname, '../dist')
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' || request.headers.host !== new URL(origin).host) {
    response.writeHead(403).end()
    return
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, origin).pathname)
    const file = path.resolve(buildDir, pathname === '/' ? 'index.html' : '.' + pathname)
    if (!file.startsWith(buildDir + path.sep) || !(await stat(file)).isFile()) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self' https://api.scryfall.com https://*.scryfall.io; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'",
    })
    createReadStream(file).on('error', () => response.destroy()).pipe(response)
  } catch {
    response.writeHead(404).end()
  }
})

function openWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 320,
    minHeight: 360,
    icon: path.join(buildDir, 'app-icon-192.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault()
  })
  window.loadURL(origin).catch((error) => dialog.showErrorBox('Living Library', error.message))
}

function startWindowsUpdates() {
  if (!app.isPackaged || process.platform !== 'win32' ||
      !existsSync(path.resolve(path.dirname(process.execPath), '../Update.exe'))) return

  function start() {
    try {
      const { updateElectronApp } = require('update-electron-app')
      updateElectronApp()
    } catch (error) {
      console.warn('Could not start the Living Library updater:', error)
    }
  }

  // Squirrel holds an installer lock on the first launch.
  if (process.argv.includes('--squirrel-firstrun')) setTimeout(start, 10_000).unref()
  else start()
}

if (require('electron-squirrel-startup')) {
  app.quit()
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.living_library.living-library')
    server.once('error', (error) => {
      dialog.showErrorBox('Living Library could not start', error.message)
      app.quit()
    })
    server.listen(Number(new URL(origin).port), '127.0.0.1', () => {
      openWindow()
      startWindowsUpdates()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) openWindow()
      })
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => server.close())
}
