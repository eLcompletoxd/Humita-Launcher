/**
 * core/modpackManager.js
 *
 * CAMBIOS:
 * - PUNTO 7:  cada modpack usa su propia carpeta de mods
 * - PUNTO 9:  usa http.js unificado (fetchJSON, download, friendlyError)
 * - PUNTO 12: directorio base separado del .minecraft oficial
 * - PUNTO 13: errores de red diferenciados
 * FIX 2:      mods descargados en parallel() en vez de for-loop síncrono
 * FIX 4:      hash SHA1 de mods usando streams (no readFileSync) → no bloquea hilo
 */

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const os     = require('os')

const config    = require('../utils/config')
const installer = require('./installer')
const { fetchJSON, download, friendlyError } = require('../utils/http')

const MODPACKS_URL   = 'https://example.com/humita/modpacks.json'
const CONCURRENCY_MODS = 4   // parallelismo conservador: los mods son grandes

// ─── Fallback ─────────────────────────────────────────────────
const FALLBACK_MODPACKS = {
  modpacks: [
    {
      id:          'survival',
      name:        'Survival SMP',
      description: 'Servidor survival con mods de calidad de vida',
      version:     '1.21.4',
      serverIp:    'play.humita.cl',
      logo:        '',
      color:       '#27ae60',
      mods:        [],
    },
    {
      id:          'skyblock',
      name:        'SkyBlock Plus',
      description: 'SkyBlock con mecánicas personalizadas',
      version:     '1.20.1',
      serverIp:    'skyblock.humita.cl',
      logo:        '',
      color:       '#3498db',
      mods:        [],
    },
  ],
}

// ─── Directorios de instancia ─────────────────────────────────

function getModpackDir(modpackId) {
  return path.join(os.homedir(), '.humita-launcher', 'instances', modpackId)
}

function getModsDir(modpackId) {
  return path.join(getModpackDir(modpackId), 'mods')
}

// ─── FIX 4: SHA1 por stream — no carga el archivo en memoria ──
/**
 * Calcula el SHA1 de un archivo usando streams.
 * Equivalente a sha1File() en installer.js, evita cargar JARs de 50MB en RAM.
 */
function sha1FileStream(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha1')
    const stream = fs.createReadStream(filePath)
    stream.on('data',  chunk => hash.update(chunk))
    stream.on('end',   ()    => resolve(hash.digest('hex')))
    stream.on('error', err   => reject(err))
  })
}

/**
 * Verifica si un mod ya existe en disco y su hash coincide.
 * Usa streams para no bloquear el hilo principal con archivos grandes.
 */
async function modFileOk(filePath, expectedSha1) {
  if (!fs.existsSync(filePath)) return false
  if (!expectedSha1)            return true  // existe pero sin hash → ok
  try {
    return (await sha1FileStream(filePath)) === expectedSha1
  } catch {
    return false
  }
}

// ─── parallel ─────────────────────────────────────────────────
// Igual que en installer.js — descarga N mods concurrentemente.

async function parallel(tasks, concurrency) {
  let index = 0
  async function worker() {
    while (index < tasks.length) {
      const i = index++
      await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
}

// ─── API pública ──────────────────────────────────────────────

async function fetchModpacks() {
  try {
    const data = await fetchJSON(MODPACKS_URL)
    if (!data.modpacks || !Array.isArray(data.modpacks)) {
      throw new Error('Formato inválido')
    }

    const withStatus = data.modpacks.map(mp => ({
      ...mp,
      installed:   isInstalled(mp.id),
      instanceDir: getModpackDir(mp.id),
    }))

    return { success: true, modpacks: withStatus }

  } catch (err) {
    const isNetwork = err.name === 'NetworkError' || err.name === 'HttpError'
    const reason    = isNetwork
      ? `Sin conexión al servidor de modpacks (${friendlyError(err)})`
      : err.message

    console.warn('[modpacks] Usando fallback. Motivo:', reason)

    const withStatus = FALLBACK_MODPACKS.modpacks.map(mp => ({
      ...mp,
      installed:   isInstalled(mp.id),
      instanceDir: getModpackDir(mp.id),
    }))

    return {
      success:       true,
      modpacks:      withStatus,
      offline:       true,
      offlineReason: reason,
    }
  }
}

async function installModpack(modpackId, modpackData, onProgress) {
  try {
    const instanceDir = getModpackDir(modpackId)
    const modsDir     = getModsDir(modpackId)
    fs.mkdirSync(instanceDir, { recursive: true })
    fs.mkdirSync(modsDir,     { recursive: true })

    // 1. Instalar Minecraft base
    onProgress({ message: `Instalando Minecraft ${modpackData.version}...`, percent: 5 })

    const installRes = await installer.install(modpackData.version, (p) => {
      onProgress({ message: p.message, percent: Math.floor(p.percent * 0.7) })
    })

    if (!installRes.success) return installRes

    // 2. Descargar mods en parallel con hash por stream
    const mods = modpackData.mods || []

    if (mods.length > 0) {
      onProgress({ message: `Verificando ${mods.length} mods...`, percent: 70 })

      let modsDone    = 0
      let modsSkipped = 0
      const modErrors = []

      // FIX 2 + FIX 4: parallel() + sha1FileStream en vez de for-loop síncrono
      await parallel(mods.map((mod, i) => async () => {
        const modPath = path.join(modsDir, mod.name + '.jar')

        // FIX 4: verificación con stream — no carga el .jar en RAM
        if (await modFileOk(modPath, mod.sha1)) {
          modsSkipped++
          onProgress({
            message: `Mod ${modsDone + 1}/${mods.length}: ${mod.name} (ya existe ✓)`,
            percent: 70 + Math.floor((modsDone / mods.length) * 25),
          })
        } else {
          try {
            await download(mod.url, modPath)
          } catch (err) {
            const friendly = friendlyError(err)
            modErrors.push({ name: mod.name, error: friendly })
            console.warn(`[modpacks] Fallo descargando ${mod.name}: ${friendly}`)
          }

          onProgress({
            message: `Mod ${modsDone + 1}/${mods.length}: ${mod.name}`,
            percent: 70 + Math.floor(((modsDone + 1) / mods.length) * 25),
          })
        }

        modsDone++
      }), CONCURRENCY_MODS)

      if (modErrors.length > 0) {
        console.warn('[modpacks] Mods con errores:', modErrors)
      }
    }

    // 3. Guardar IP
    config.set('lastServerIp', modpackData.serverIp)

    // 4. Marcar como instalado
    markInstalled(modpackId, modpackData)
    onProgress({ message: `¡${modpackData.name} instalado!`, percent: 100 })

    return {
      success:     true,
      message:     `${modpackData.name} instalado correctamente.`,
      instanceDir,
    }

  } catch (err) {
    return { success: false, message: friendlyError(err) }
  }
}

// ─── Estado de instalación ────────────────────────────────────

function isInstalled(modpackId) {
  const installed = config.get('installedModpacks') || {}
  return Boolean(installed[modpackId])
}

function markInstalled(modpackId, modpackData) {
  const installed = config.get('installedModpacks') || {}
  installed[modpackId] = {
    version:     modpackData.version,
    serverIp:    modpackData.serverIp,
    instanceDir: getModpackDir(modpackId),
    installedAt: new Date().toISOString(),
  }
  config.set('installedModpacks', installed)
}

function getInstalledInfo(modpackId) {
  const installed = config.get('installedModpacks') || {}
  return installed[modpackId] || null
}

module.exports = { fetchModpacks, installModpack, isInstalled, getInstalledInfo, getModpackDir }
