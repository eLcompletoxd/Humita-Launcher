/**
 * utils/installStateManager.js
 * CORRECCIÓN:
 * - FIX 3: race condition en markLibDone(). Antes, dos corrutinas
 *   concurrentes podían pasar el includes() al mismo tiempo y hacer
 *   push() dos veces del mismo relPath, inflando el array.
 *   Ahora se usa un Set interno (_completedSetFast) para la
 *   deduplicación en memoria, que es O(1) y atómico dentro del event
 *   loop de Node. El array completedSet del estado en disco se
 *   reconstruye desde el Set al hacer flush.
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')

const STATE_DIR = path.join(os.homedir(), '.humita-launcher', 'install-state')

// ─── Helpers de disco ────────────────────────────────────────────────────────

function stateFile(versionId) {
  return path.join(STATE_DIR, `${versionId}.json`)
}

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true })
  }
}

function readState(versionId) {
  try {
    const file = stateFile(versionId)
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'))
    }
  } catch (e) {
    console.warn(`[installState] Error leyendo estado de ${versionId}:`, e.message)
  }
  return null
}

function writeState(state) {
  try {
    ensureDir()
    fs.writeFileSync(stateFile(state.versionId), JSON.stringify(state, null, 2), 'utf-8')
  } catch (e) {
    console.warn(`[installState] Error guardando estado:`, e.message)
  }
}

function deleteState(versionId) {
  try {
    const file = stateFile(versionId)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (e) {
    console.warn(`[installState] Error borrando estado de ${versionId}:`, e.message)
  }
}

// ─── API pública ─────────────────────────────────────────────────────────────

class InstallStateManager {
  constructor(versionId) {
    this.versionId = versionId
    this._state    = null
    this._isResume = false

    // FIX 3: Set en memoria para deduplicar markLibDone() sin race conditions.
    // Node.js es single-threaded pero las corrutinas (async/await) se
    // intercalan: dos workers pueden pasar el `if (!set.has(x))` antes de
    // que cualquiera haga el `add()`. Con Set la comprobación + inserción
    // ocurren en el mismo tick del event loop, sin posibilidad de intercalado.
    this._completedSetFast = new Set()
  }

  init() {
    const existing = readState(this.versionId)

    if (existing) {
      this._state    = existing
      this._isResume = true
      this._state.resumedAt   = new Date().toISOString()
      this._state.resumeCount = (this._state.resumeCount || 0) + 1

      // FIX 3: reconstruir el Set desde el array persistido en disco
      this._completedSetFast = new Set(this._state.libs.completedSet || [])
    } else {
      this._state = {
        versionId:   this.versionId,
        startedAt:   new Date().toISOString(),
        resumedAt:   null,
        resumeCount: 0,
        steps: {
          metadata: 'pending',
          client:   'pending',
          libs:     'pending',
          assets:   'pending',
        },
        libs: {
          total:        0,
          completed:    0,
          completedSet: [],
          errors:       [],
        },
        assets: {
          indexId:   null,
          total:     0,
          completed: 0,
        },
      }
      this._isResume         = false
      this._completedSetFast = new Set()
    }

    writeState(this._state)
    return { isResume: this._isResume, resumeCount: this._state.resumeCount }
  }

  get isResume() { return this._isResume }

  // ── Steps ────────────────────────────────────────────────────

  isStepDone(step) {
    return this._state.steps[step] === 'done'
  }

  markStepDone(step) {
    this._state.steps[step] = 'done'
    writeState(this._state)
  }

  markStepPartial(step) {
    this._state.steps[step] = 'partial'
    writeState(this._state)
  }

  // ── Libs ─────────────────────────────────────────────────────

  initLibs(total) {
    if (!this._isResume || this._state.libs.total !== total) {
      this._state.libs       = { total, completed: 0, completedSet: [], errors: [] }
      this._completedSetFast = new Set()
    } else {
      // FIX 3: reconstruir el Set desde el array del estado anterior.
      // Si ya se hizo en init(), esto es una no-op. Se repite aquí
      // por si initLibs() se llama sin haber llamado init() antes.
      this._completedSetFast = new Set(this._state.libs.completedSet)
      this._state.libs.completed = this._completedSetFast.size
    }
    this._state.steps.libs = 'partial'
    writeState(this._state)
  }

  /**
   * FIX 3: isLibDone() ahora consulta el Set en memoria (_completedSetFast)
   * en lugar del array. O(1) vs O(n), y sin riesgo de duplicados.
   */
  isLibDone(relPath) {
    return this._completedSetFast.has(relPath)
  }

  /**
   * FIX 3: markLibDone() usa Set.add() para que sea idempotente.
   * Aunque dos corrutinas llamen a markLibDone() con el mismo relPath
   * al mismo tiempo, Set.add() solo lo registra una vez.
   * El array completedSet del JSON se sincroniza al llamar flushLibs().
   */
  markLibDone(relPath, persist = false) {
    this._completedSetFast.add(relPath)
    if (persist) {
      this._syncLibsToState()
      writeState(this._state)
    }
  }

  markLibError(relPath) {
    if (!this._state.libs.errors.includes(relPath)) {
      this._state.libs.errors.push(relPath)
    }
  }

  /**
   * FIX 3: flushLibs() reconstruye el array desde el Set antes de
   * escribir al disco, garantizando que no haya duplicados en el JSON.
   */
  flushLibs() {
    this._syncLibsToState()
    writeState(this._state)
  }

  /** Sincroniza el Set en memoria → array del estado (sin duplicados). */
  _syncLibsToState() {
    this._state.libs.completedSet = Array.from(this._completedSetFast)
    this._state.libs.completed    = this._completedSetFast.size
  }

  get libsCompleted()    { return this._completedSetFast.size }
  get libsCompletedSet() { return Array.from(this._completedSetFast) }

  // ── Assets ───────────────────────────────────────────────────

  initAssets(indexId, total) {
    this._state.assets       = { indexId, total, completed: 0 }
    this._state.steps.assets = 'partial'
    writeState(this._state)
  }

  updateAssetsProgress(completed) {
    this._state.assets.completed = completed
    if (completed % 100 === 0) writeState(this._state)
  }

  // ── Finalización ─────────────────────────────────────────────

  complete() {
    deleteState(this.versionId)
  }

  reset() {
    deleteState(this.versionId)
  }

  // ── Info de UI ────────────────────────────────────────────────

  getSummary() {
    const s = this._state
    return {
      isResume:    this._isResume,
      resumeCount: s.resumeCount,
      steps:       { ...s.steps },
      libsDone:    this._completedSetFast.size,
      libsTotal:   s.libs.total,
    }
  }
}

// ─── Utilidad de consulta sin instancia ──────────────────────────────────────

function hasInterruptedInstall(versionId) {
  return fs.existsSync(stateFile(versionId))
}

module.exports = { InstallStateManager, hasInterruptedInstall }
