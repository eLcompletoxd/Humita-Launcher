/**
 * core/installer.js
 * CORRECCIÓN:
 * - FIX 10: los errores de librerías ya no se silencian con solo un
 *   console.warn. Si alguna librería falló, el mensaje final de progreso
 *   lo indica con un aviso visible en la UI para que el usuario sepa
 *   que el juego podría no funcionar correctamente.
 */

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const config         = require('../utils/config')
const versionManager = require('./versionManager')
const { download, friendlyError } = require('../utils/http')
const { InstallStateManager }     = require('../utils/installStateManager')

const CONCURRENCY_LIBS   = 16
const CONCURRENCY_ASSETS = 32
const LIBS_FLUSH_EVERY   = 20

// ─── Utilidades ───────────────────────────────────────────────────────────────

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

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha1')
    const stream = fs.createReadStream(filePath)
    stream.on('data', d => hash.update(d))
    stream.on('end',  () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function fileOk(filePath, expectedSha1) {
  if (!fs.existsSync(filePath)) return false
  if (!expectedSha1)            return true
  try {
    return (await sha1File(filePath)) === expectedSha1
  } catch {
    return false
  }
}

// ─── Install principal ────────────────────────────────────────────────────────

async function install(versionId, onProgress) {
  const stateManager = new InstallStateManager(versionId)
  const { isResume, resumeCount } = stateManager.init()

  if (isResume) {
    onProgress({
      step:    'resume',
      message: `Reanudando instalación interrumpida (intento ${resumeCount + 1})...`,
      percent: 1,
    })
  }

  try {
    const mcDir       = config.minecraftDir
    const versionsDir = path.join(mcDir, 'versions', versionId)
    fs.mkdirSync(versionsDir, { recursive: true })

    // ── PASO 1: Metadatos ────────────────────────────────────────────────────

    let metadata = null

    if (stateManager.isStepDone('metadata')) {
      const metaPath = path.join(versionsDir, `${versionId}.json`)
      try {
        metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        onProgress({ step: 'metadata', message: 'Metadatos ya descargados ✓', percent: 4 })
      } catch {
        stateManager.markStepPartial('metadata')
        metadata = null
      }
    }

    if (!metadata) {
      onProgress({ step: 'metadata', message: 'Descargando metadatos...', percent: 2 })

      const manifestRes = await versionManager.fetchVersions(true)
      if (!manifestRes.success) {
        return {
          success: false,
          message: manifestRes.error?.includes('ENOTFOUND')
            ? 'Sin conexión a internet. No se pudo obtener la lista de versiones.'
            : `Error al obtener versiones: ${manifestRes.error}`,
        }
      }

      const ver = manifestRes.versions.find(v => v.id === versionId)
      if (!ver) {
        return { success: false, message: `Versión ${versionId} no encontrada en el manifest de Mojang.` }
      }

      const metaPath = path.join(versionsDir, `${versionId}.json`)

      if (fs.existsSync(metaPath)) {
        try {
          metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          onProgress({ step: 'metadata', message: 'Metadatos ya en disco ✓', percent: 4 })
        } catch {
          metadata = null
        }
      }

      if (!metadata) {
        try {
          metadata = await versionManager.getVersionMetadata(ver.url)
          fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2))
        } catch (err) {
          return { success: false, message: `Error descargando metadatos: ${friendlyError(err)}` }
        }
      }

      stateManager.markStepDone('metadata')
      onProgress({ step: 'metadata', message: 'Metadatos descargados ✓', percent: 4 })
    }

    // ── PASO 2: Client JAR ───────────────────────────────────────────────────

    const clientInfo = metadata.downloads?.client
    const clientJar  = path.join(versionsDir, `${versionId}.jar`)

    if (stateManager.isStepDone('client')) {
      onProgress({ step: 'client', message: 'Cliente ya descargado ✓', percent: 25 })
    } else {
      onProgress({ step: 'client', message: 'Verificando cliente de Minecraft...', percent: 5 })

      if (await fileOk(clientJar, clientInfo?.sha1)) {
        stateManager.markStepDone('client')
        onProgress({ step: 'client', message: 'Cliente ya en disco ✓', percent: 25 })
      } else {
        try {
          await download(clientInfo.url, clientJar, p =>
            onProgress({
              step:    'client',
              message: `Descargando cliente: ${p}%`,
              percent: 5 + Math.floor(p * 0.2),
            })
          )
          stateManager.markStepDone('client')
          onProgress({ step: 'client', message: 'Cliente descargado ✓', percent: 25 })
        } catch (err) {
          return {
            success: false,
            message: `Error descargando el cliente de Minecraft: ${friendlyError(err)}`,
          }
        }
      }
    }

    // ── PASO 3: Librerías ────────────────────────────────────────────────────

    if (stateManager.isStepDone('libs')) {
      onProgress({ step: 'libs', message: 'Librerías ya instaladas ✓', percent: 55 })
    } else {
      const libs    = (metadata.libraries || []).filter(l => l.downloads?.artifact)
      const libsDir = path.join(mcDir, 'libraries')

      stateManager.initLibs(libs.length)

      const previouslyDone = stateManager.libsCompleted
      const isLibResume    = isResume && previouslyDone > 0

      if (isLibResume) {
        onProgress({
          step:    'libs',
          message: `Reanudando librerías desde ${previouslyDone}/${libs.length}...`,
          percent: 25 + Math.floor((previouslyDone / libs.length) * 30),
        })
      } else {
        onProgress({ step: 'libs', message: 'Verificando librerías...', percent: 25 })
      }

      let libsDone    = previouslyDone
      let libsSkipped = 0
      let libsFlushed = 0
      const libErrors = []

      const pendingLibs = libs.filter(lib => {
        const { path: relPath } = lib.downloads.artifact
        return !stateManager.isLibDone(relPath)
      })

      await parallel(pendingLibs.map(lib => async () => {
        const { path: relPath, url, sha1 } = lib.downloads.artifact
        const libPath = path.join(libsDir, relPath)
        fs.mkdirSync(path.dirname(libPath), { recursive: true })

        if (await fileOk(libPath, sha1)) {
          libsSkipped++
          stateManager.markLibDone(relPath)
        } else {
          try {
            await download(url, libPath)
            stateManager.markLibDone(relPath)
          } catch (err) {
            libErrors.push({ name: relPath, error: friendlyError(err) })
            stateManager.markLibError(relPath)
          }
        }

        libsDone++
        libsFlushed++

        if (libsFlushed >= LIBS_FLUSH_EVERY || libsDone === libs.length) {
          stateManager.flushLibs()
          libsFlushed = 0
        }

        const skippedNote = libsSkipped > 0 ? ` (${libsSkipped} ya existían)` : ''
        const resumeNote  = isLibResume && libsDone <= previouslyDone ? ' [reanudando]' : ''
        if (libsDone % 5 === 0 || libsDone === libs.length) {
          onProgress({
            step:    'libs',
            message: `Librerías: ${libsDone}/${libs.length}${skippedNote}${resumeNote}`,
            percent: 25 + Math.floor((libsDone / libs.length) * 30),
          })
        }
      }), CONCURRENCY_LIBS)

      // FIX 10: reportar errores de librerías al usuario en lugar de
      // silenciarlos con solo un console.warn. Se usa una advertencia
      // visible en la UI para que el usuario sepa que puede haber problemas.
      if (libErrors.length > 0) {
        console.warn(`[installer] ${libErrors.length} librería(s) fallaron:`, libErrors)
        onProgress({
          step:    'libs',
          message: `⚠ ${libErrors.length} librería(s) no se descargaron. El juego podría no iniciar correctamente.`,
          percent: 55,
        })
      }

      stateManager.markStepDone('libs')

      // FIX 10: el mensaje final incluye la advertencia si hubo errores
      const libsDoneMsg = libErrors.length > 0
        ? `Librerías: ${libs.length - libErrors.length}/${libs.length} ✓  (${libErrors.length} fallaron)`
        : `Librerías completadas: ${libs.length}/${libs.length} ✓`

      onProgress({ step: 'libs', message: libsDoneMsg, percent: 55 })
    }

    // ── PASO 4: Assets ───────────────────────────────────────────────────────

    if (stateManager.isStepDone('assets')) {
      onProgress({ step: 'assets', message: 'Assets ya descargados ✓', percent: 95 })
    } else {
      onProgress({ step: 'assets', message: 'Verificando assets...', percent: 55 })
      if (metadata.assetIndex) {
        try {
          await downloadAssets(metadata.assetIndex, mcDir, onProgress, stateManager, isResume)
        } catch (err) {
          return {
            success: false,
            message: `Error descargando assets: ${friendlyError(err)}`,
          }
        }
      }
      stateManager.markStepDone('assets')
    }

    // ── DONE ─────────────────────────────────────────────────────────────────

    versionManager.markInstalled(versionId)
    stateManager.complete()

    onProgress({ step: 'done', message: `Minecraft ${versionId} instalado correctamente ✓`, percent: 100 })
    return { success: true, message: `Minecraft ${versionId} instalado correctamente.` }

  } catch (err) {
    return { success: false, message: friendlyError(err) }
  }
}

// ─── Assets ───────────────────────────────────────────────────────────────────

async function downloadAssets(assetIndexInfo, mcDir, onProgress, stateManager, isResume) {
  const indexDir = path.join(mcDir, 'assets', 'indexes')
  const objDir   = path.join(mcDir, 'assets', 'objects')
  fs.mkdirSync(indexDir, { recursive: true })
  fs.mkdirSync(objDir,   { recursive: true })

  const indexFile = path.join(indexDir, `${assetIndexInfo.id}.json`)

  if (!fs.existsSync(indexFile)) {
    try {
      await download(assetIndexInfo.url, indexFile)
    } catch (err) {
      throw new Error(`No se pudo descargar el índice de assets: ${friendlyError(err)}`)
    }
  }

  let objects
  try {
    objects = Object.values(JSON.parse(fs.readFileSync(indexFile, 'utf-8')).objects || {})
  } catch {
    throw new Error('El índice de assets está corrupto. Borra el archivo e intenta de nuevo.')
  }

  const pending = objects.filter(({ hash }) =>
    !fs.existsSync(path.join(objDir, hash.slice(0, 2), hash))
  )

  stateManager.initAssets(assetIndexInfo.id, objects.length)

  const alreadyDone = objects.length - pending.length

  if (pending.length === 0) {
    onProgress({ step: 'assets', message: 'Assets ya descargados ✓', percent: 95 })
    return
  }

  if (isResume && alreadyDone > 0) {
    onProgress({
      step:    'assets',
      message: `Reanudando assets: ${alreadyDone}/${objects.length} ya existían, descargando ${pending.length}...`,
      percent: 55 + Math.floor((alreadyDone / objects.length) * 40),
    })
  } else {
    onProgress({
      step:    'assets',
      message: `Descargando ${pending.length} assets...`,
      percent: 55,
    })
  }

  let done        = alreadyDone
  let assetErrors = 0

  await parallel(pending.map(({ hash }) => async () => {
    const prefix  = hash.slice(0, 2)
    const objPath = path.join(objDir, prefix, hash)
    fs.mkdirSync(path.dirname(objPath), { recursive: true })

    try {
      await download(`https://resources.download.minecraft.net/${prefix}/${hash}`, objPath)
    } catch {
      assetErrors++
    }

    done++
    stateManager.updateAssetsProgress(done)

    if (done % 50 === 0 || done === objects.length) {
      const errorNote = assetErrors > 0 ? ` (${assetErrors} fallos)` : ''
      onProgress({
        step:    'assets',
        message: `Assets: ${done}/${objects.length}${errorNote}`,
        percent: 55 + Math.floor((done / objects.length) * 40),
      })
    }
  }), CONCURRENCY_ASSETS)

  if (assetErrors > 0) {
    console.warn(`[installer] ${assetErrors} assets fallaron al descargar`)
  }
}

module.exports = { install }
