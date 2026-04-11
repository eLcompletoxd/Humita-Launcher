/**
 * utils/javaFinder.js
 * CORRECCIÓN:
 * - FIX 9: la ruta obtenida desde PATH/which ahora se valida con
 *   verifyJava() antes de retornarla, en lugar de devolverla a ciegas.
 *   Esto evita que shims rotos (jenv, sdkman mal configurado, etc.)
 *   lleguen al launcher y causen un error críptico al intentar lanzar.
 */

const { spawnSync } = require('child_process')
const fs   = require('fs')
const path = require('path')
const os   = require('os')

const COMMON_PATHS = {
  win32: [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Zulu',
  ],
  linux: ['/usr/lib/jvm', '/usr/local/lib/jvm', '/opt/java', '/opt/jdk'],
  darwin: [
    '/Library/Java/JavaVirtualMachines',
    '/System/Library/Java/JavaVirtualMachines',
  ],
}

function findJava() {
  // 1. Desde PATH — FIX 9: verificar la ruta con verifyJava() antes de usarla
  try {
    const whichCmd = os.platform() === 'win32' ? 'where' : 'which'
    const which = spawnSync(whichCmd, ['java'], { encoding: 'utf-8' })
    if (which.status === 0) {
      const candidates = which.stdout.trim().split('\n')
      for (const candidate of candidates) {
        const resolved = candidate.trim()
        // FIX 9: antes se retornaba el primer resultado sin validar.
        // Ahora se verifica que realmente ejecute (descarta shims rotos).
        if (resolved && verifyJava(resolved)) return resolved
      }
    }
  } catch {}

  // 2. JAVA_HOME env
  const javaHome = process.env.JAVA_HOME
  if (javaHome) {
    const bin = path.join(javaHome, 'bin', os.platform() === 'win32' ? 'java.exe' : 'java')
    if (verifyJava(bin)) return bin
  }

  // 3. Rutas comunes
  const platform = os.platform()
  const paths = COMMON_PATHS[platform] || []

  for (const base of paths) {
    if (!fs.existsSync(base)) continue
    const found = searchJavaIn(base)
    if (found) return found
  }

  return null
}

function searchJavaIn(dir) {
  const javaExe = os.platform() === 'win32' ? 'java.exe' : 'java'
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(dir, entry.name, 'bin', javaExe)
      if (verifyJava(candidate)) return candidate
    }
  } catch {}
  return null
}

function verifyJava(javaPath) {
  if (!javaPath || !fs.existsSync(javaPath)) return false
  try {
    const result = spawnSync(javaPath, ['-version'], { encoding: 'utf-8', timeout: 5000 })
    return result.status === 0
  } catch {
    return false
  }
}

function getVersion(javaPath) {
  try {
    const result = spawnSync(javaPath, ['-version'], { encoding: 'utf-8', timeout: 5000 })
    const output = result.stderr || result.stdout || ''
    const match  = output.match(/version "([^"]+)"/)
    return match ? match[1] : 'Desconocida'
  } catch {
    return 'Desconocida'
  }
}

module.exports = { findJava, verifyJava, getVersion }
