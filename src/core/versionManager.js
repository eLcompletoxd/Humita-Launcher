/**
 * core/versionManager.js
 * CORRECCIÓN:
 * - FIX 14: el manifest de versiones de Mojang ahora tiene un TTL de
 *   10 minutos. Si el launcher lleva más tiempo abierto y el usuario
 *   intenta instalar una versión, se re-descarga el manifest en vez
 *   de usar una copia que podría tener horas de antigüedad.
 */

const config = require('../utils/config')
const { fetchJSON, friendlyError } = require('../utils/http')

const MANIFEST_URL   = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
const MANIFEST_TTL_MS = 10 * 60 * 1000  // 10 minutos

let _manifestCache     = null
let _manifestFetchedAt = 0   // timestamp de la última descarga exitosa

// ─── Comprueba si el caché sigue siendo válido ────────────────
function _isCacheValid() {
  return _manifestCache !== null && (Date.now() - _manifestFetchedAt) < MANIFEST_TTL_MS
}

async function fetchVersions(includeSnapshots = false) {
  try {
    // FIX 14: solo reutilizar el caché si no ha expirado
    if (!_isCacheValid()) {
      _manifestCache     = await fetchJSON(MANIFEST_URL)
      _manifestFetchedAt = Date.now()
    }

    const manifest = _manifestCache

    const versions = manifest.versions
      .filter(v => v.type === 'release' || (includeSnapshots && v.type === 'snapshot'))
      .map(v => ({
        id:          v.id,
        type:        v.type,
        url:         v.url,
        releaseTime: v.releaseTime,
        installed:   isInstalled(v.id),
      }))

    return { success: true, versions, latest: manifest.latest?.release }
  } catch (err) {
    return {
      success:  false,
      error:    friendlyError(err),
      versions: [],
    }
  }
}

async function getVersionMetadata(url) {
  return fetchJSON(url)
}

function isInstalled(versionId) {
  const installed = config.get('installedVersions') || []
  return installed.includes(versionId)
}

function markInstalled(versionId) {
  const installed = config.get('installedVersions') || []
  if (!installed.includes(versionId)) {
    config.set('installedVersions', [...installed, versionId])
  }
}

function getLatest() {
  return _manifestCache?.latest?.release || null
}

/** Fuerza la invalidación del caché (útil para tests o recarga manual). */
function invalidateCache() {
  _manifestCache     = null
  _manifestFetchedAt = 0
}

module.exports = { fetchVersions, getVersionMetadata, isInstalled, markInstalled, getLatest, invalidateCache }
