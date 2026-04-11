/**
 * preload.js
 * CAMBIOS:
 * - PUNTO 2 (listeners): onProgress/onLog usan removeAllListeners antes de agregar
 *   el nuevo callback, evitando acumulación en sesiones largas
 * - PUNTO 7+12: launcher.launch ahora acepta modpackId
 * - PUNTO 4: auth.logout es async
 */

const { contextBridge, ipcRenderer } = require('electron')

/**
 * Helper: registra un listener de evento IPC limpiando el anterior primero.
 * Esto evita que llamadas repetidas a onProgress/onLog acumulen callbacks.
 */
function onChannel(channel, cb) {
  ipcRenderer.removeAllListeners(channel)
  ipcRenderer.on(channel, (_, data) => cb(data))
}

contextBridge.exposeInMainWorld('api', {

  // Window
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    close:    () => ipcRenderer.send('window:close'),
  },

  // Config
  config: {
    get:    (key)        => ipcRenderer.invoke('config:get', key),
    set:    (key, value) => ipcRenderer.invoke('config:set', key, value),
    getAll: ()           => ipcRenderer.invoke('config:getAll'),
  },

  // Auth
  auth: {
    loginOffline:   (username) => ipcRenderer.invoke('auth:loginOffline', username),
    loginMicrosoft: ()         => ipcRenderer.invoke('auth:loginMicrosoft'),
    refresh:        ()         => ipcRenderer.invoke('auth:refresh'),
    logout:         ()         => ipcRenderer.invoke('auth:logout'), // ahora async
  },

  // Versions
  versions: {
    fetch:       (snapshots) => ipcRenderer.invoke('versions:fetch', snapshots),
    isInstalled: (id)        => ipcRenderer.invoke('versions:isInstalled', id),
  },

  // Installer
  installer: {
    install:        (id) => ipcRenderer.invoke('installer:install', id),
    // FIX 5: consulta si hay instalación interrumpida en disco para una versión
    hasInterrupted: (versionId) => ipcRenderer.invoke('installer:hasInterrupted', versionId),
    // PUNTO 2: limpiar listener anterior antes de agregar nuevo
    onProgress:     (cb) => onChannel('installer:progress', cb),
  },

  // Launcher
  launcher: {
    // PUNTO 7+12: acepta modpackId para usar el gameDir correcto
    launch: (id, serverIp, modpackId) =>
      ipcRenderer.invoke('launcher:launch', id, serverIp, modpackId),
    kill:  () => ipcRenderer.invoke('launcher:kill'),
    // PUNTO 2: limpiar listener anterior
    onLog: (cb) => onChannel('launcher:log', cb),
  },

  // Java
  java: {
    find:       ()     => ipcRenderer.invoke('java:find'),
    getVersion: (path) => ipcRenderer.invoke('java:getVersion', path),
  },

  // Modpacks
  modpacks: {
    fetch:       ()          => ipcRenderer.invoke('modpacks:fetch'),
    install:     (id, data)  => ipcRenderer.invoke('modpacks:install', id, data),
    isInstalled: (id)        => ipcRenderer.invoke('modpacks:isInstalled', id),
    // PUNTO 2: limpiar listener anterior
    onProgress:  (cb) => onChannel('modpacks:progress', cb),
  },

  // Shell
  shell: {
    openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  },
})
