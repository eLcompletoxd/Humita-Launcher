/**
 * main.js
 * CAMBIOS:
 * - PUNTO 4:  auth.logout ahora es async
 * - PUNTO 7+12: launcher recibe modpackId para usar el gameDir correcto
 * - PUNTO 10: validación básica de parámetros en handlers IPC
 */

const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron')
const path = require('path')
const isDev = process.argv.includes('--dev')

const authManager    = require('./core/auth')
const versionManager = require('./core/versionManager')
const installer      = require('./core/installer')
const gameLauncher   = require('./core/launcher')
const modpackManager = require('./core/modpackManager')
const config         = require('./utils/config')
const javaFinder     = require('./utils/javaFinder')

let mainWindow

function createWindow() {
mainWindow = new BrowserWindow({
    width: 1280 ,  // Cambiar de 960
    height: 720 ,  // Cambiar de 620
    minWidth: 1280 ,
    minHeight: 720 ,
    maxWidth: 1280 ,
    maxHeight: 720 ,
    resizable: false, maximizable: false, fullscreenable: false,
    frame: true,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
  })

  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'))
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── Helpers de validación ────────────────────────────────────
// PUNTO 10: validar parámetros críticos en cada handler

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Parámetro inválido: "${name}" debe ser un string no vacío`)
  }
}

// ─── Window controls ──────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:close',    () => mainWindow?.close())

// ─── Config ───────────────────────────────────────────────────
ipcMain.handle('config:get',    (_, key)        => config.get(key))
ipcMain.handle('config:set',    (_, key, value) => { config.set(key, value) })
ipcMain.handle('config:getAll', ()              => config.store)

// ─── Auth ─────────────────────────────────────────────────────
ipcMain.handle('auth:loginOffline', async (_, username) => {
  try {
    assertString(username, 'username')
    return await authManager.loginOffline(username)
  } catch (err) {
    return { success: false, message: err.message }
  }
})

ipcMain.handle('auth:loginMicrosoft', async () => {
  return await authManager.loginMicrosoft()
})

ipcMain.handle('auth:refresh', async () => {
  return await authManager.refreshSession()
})

// PUNTO 4: logout es async (necesita limpiar keychain)
ipcMain.handle('auth:logout', async () => {
  return await authManager.logout()
})

// ─── Versions ─────────────────────────────────────────────────
ipcMain.handle('versions:fetch', async (_, includeSnapshots) => {
  return await versionManager.fetchVersions(Boolean(includeSnapshots))
})

ipcMain.handle('versions:isInstalled', (_, versionId) => {
  return versionManager.isInstalled(versionId)
})

// ─── Installer ────────────────────────────────────────────────
ipcMain.handle('installer:install', async (_, versionId) => {
  try {
    assertString(versionId, 'versionId')
    return await installer.install(versionId, (progress) => {
      mainWindow?.webContents.send('installer:progress', progress)
    })
  } catch (err) {
    return { success: false, message: err.message }
  }
})

// FIX 5: exponer hasInterruptedInstall al renderer
ipcMain.handle('installer:hasInterrupted', (_, versionId) => {
  const { hasInterruptedInstall } = require('./utils/installStateManager')
  return hasInterruptedInstall(versionId)
})

// ─── Launcher ─────────────────────────────────────────────────
// PUNTO 7+12: ahora recibe modpackId para usar el gameDir correcto
ipcMain.handle('launcher:launch', async (_, versionId, serverIp, modpackId) => {
  try {
    assertString(versionId, 'versionId')
    return await gameLauncher.launch(versionId, serverIp, (line) => {
      mainWindow?.webContents.send('launcher:log', line)
    }, modpackId || null)
  } catch (err) {
    return { success: false, message: err.message }
  }
})

ipcMain.handle('launcher:kill', () => gameLauncher.kill())

// ─── Java ─────────────────────────────────────────────────────
ipcMain.handle('java:find',       async ()           => javaFinder.findJava())
ipcMain.handle('java:getVersion', async (_, javaPath) => {
  try {
    assertString(javaPath, 'javaPath')
    return javaFinder.getVersion(javaPath)
  } catch {
    return 'Desconocida'
  }
})

// ─── Modpacks ─────────────────────────────────────────────────
ipcMain.handle('modpacks:fetch', async () => {
  return await modpackManager.fetchModpacks()
})

ipcMain.handle('modpacks:install', async (_, modpackId, modpackData) => {
  try {
    assertString(modpackId, 'modpackId')
    if (!modpackData || typeof modpackData !== 'object') {
      return { success: false, message: 'Datos del modpack inválidos.' }
    }
    return await modpackManager.installModpack(modpackId, modpackData, (progress) => {
      mainWindow?.webContents.send('modpacks:progress', progress)
    })
  } catch (err) {
    return { success: false, message: err.message }
  }
})

ipcMain.handle('modpacks:isInstalled', (_, modpackId) => {
  return modpackManager.isInstalled(modpackId)
})

ipcMain.handle('app:version', () => {
  return app.getVersion();
})

// ─── Shell ────────────────────────────────────────────────────
ipcMain.on('shell:openExternal', (_, url) => {
  // Validar que sea una URL http/https antes de abrirla
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    shell.openExternal(url)
  }
})