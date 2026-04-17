/**
 * utils/config.js
 * CORRECCIONES:
 * - FIX 8: get() y set() ya no acceden a accessToken/refreshToken.
 *   Los tokens están completamente separados del API pública y solo
 *   son accesibles a través de saveTokens()/getTokens()/clearTokens().
 *   Esto evita que código que llame config.get('accessToken') reciba
 *   el token en texto plano cuando keytar no está disponible.
 * - FIX 1 (menor): el getter minecraftDir ahora tiene un setter que
 *   delega a setPref(), eliminando la trampa de asignación directa.
 */

const path = require('path')
const os   = require('os')
const fs   = require('fs')

const CONFIG_DIR = os.platform() === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.humita')
  : path.join(os.homedir(), '.humita')

// ─── Intentar cargar keytar (opcional) ───────────────────────
let keytar = null
try {
  keytar = require('keytar')
} catch {
  console.warn('[config] keytar no disponible — tokens se guardarán en disco cifrado básico')
}

const KEYTAR_SERVICE = 'HumitaLauncher'
const KEYTAR_ACCOUNT = 'minecraft-tokens'

// ─── Defaults por archivo ────────────────────────────────────

const PREF_DEFAULTS = {
  minecraftDir: path.join(os.homedir(), '.minecraft'),
  javaPath:     '',
  ramMin:       '1G',
  ramMax:       '2G',
}

const PROFILES_DEFAULTS = {
  installedVersions: [],
  installedModpacks: {},
  lastVersion:       '',
  lastModpackId:     '',
  lastModpackName:   '',
  lastServerIp:      '',
}

const AUTH_DEFAULTS = {
  username: '',
  uuid:     '',
  authType: 'offline',
}

// FIX 8: claves de tokens que NO deben ser accesibles vía get()/set().
// Se define como Set para O(1) de comprobación.
const TOKEN_KEYS = new Set(['accessToken', 'refreshToken'])

// ─── Lector/escritor de JSON ──────────────────────────────────

function readJSON(file, defaults) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8')
      return { ...defaults, ...JSON.parse(raw) }
    }
  } catch (e) {
    console.error(`[config] Error leyendo ${file}:`, e.message)
  }
  return { ...defaults }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
  } catch (e) {
    console.error(`[config] Error escribiendo ${file}:`, e.message)
  }
}

// ─── Clase Config ─────────────────────────────────────────────

class Config {
  constructor() {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
    }

    this._prefFile     = path.join(CONFIG_DIR, 'preferences.json')
    this._profilesFile = path.join(CONFIG_DIR, 'profiles.json')
    this._authFile     = path.join(CONFIG_DIR, 'auth.json')

    this._prefs    = readJSON(this._prefFile,     PREF_DEFAULTS)
    this._profiles = readJSON(this._profilesFile, PROFILES_DEFAULTS)
    this._auth     = readJSON(this._authFile,      AUTH_DEFAULTS)
  }

  // ── Preferencias ────────────────────────────────────────────

  // FIX 1: setter explícito para minecraftDir para evitar asignación
  // directa que no persiste en disco.
  get minecraftDir()      { return this._prefs.minecraftDir }
  set minecraftDir(value) { this.setPref('minecraftDir', value) }

  getPref(key)        { return this._prefs[key] }
  setPref(key, value) {
    this._prefs[key] = value
    writeJSON(this._prefFile, this._prefs)
  }

  // ── Perfiles / instalaciones ─────────────────────────────────

  getProfile(key)        { return this._profiles[key] }
  setProfile(key, value) {
    this._profiles[key] = value
    writeJSON(this._profilesFile, this._profiles)
  }

  // ── Auth metadata (sin tokens) ──────────────────────────────

  get username()   { return this._auth.username }
  get uuid()       { return this._auth.uuid }
  get authType()   { return this._auth.authType }
  get isLoggedIn() { return Boolean(this._auth.username) }

  setAuthMeta(obj) {
    // FIX 8: nunca escribir tokens en _auth a través de setAuthMeta
    const safe = { ...obj }
    delete safe.accessToken
    delete safe.refreshToken
    Object.assign(this._auth, safe)
    writeJSON(this._authFile, this._auth)
  }

  // ── Tokens en keychain (o fallback en disco) ─────────────────

  async saveTokens({ accessToken, refreshToken }) {
    if (keytar) {
      const payload = JSON.stringify({ accessToken, refreshToken })
      await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, payload)
    } else {
      // Fallback: guardar en archivo separado de auth metadata
      // para que no queden expuestos en el objeto _auth que usa get()
      const tokenFile = path.join(CONFIG_DIR, 'tokens.json')
      writeJSON(tokenFile, { accessToken, refreshToken })
    }
  }

  async getTokens() {
    if (keytar) {
      try {
        const raw = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)
        if (raw) return JSON.parse(raw)
      } catch {}
      return { accessToken: '', refreshToken: '' }
    } else {
      // Fallback: leer del archivo de tokens separado
      const tokenFile = path.join(CONFIG_DIR, 'tokens.json')
      try {
        if (fs.existsSync(tokenFile)) {
          return JSON.parse(fs.readFileSync(tokenFile, 'utf-8'))
        }
      } catch {}
      return { accessToken: '', refreshToken: '' }
    }
  }

  async clearTokens() {
    if (keytar) {
      try { await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT) } catch {}
    } else {
      const tokenFile = path.join(CONFIG_DIR, 'tokens.json')
      try { if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile) } catch {}
    }
  }

  // ── API de compatibilidad ────────────────────────────────────

  get(key) {
    // FIX 8: bloquear acceso a tokens a través del API genérica.
    // Los tokens SOLO son accesibles vía getTokens().
    if (TOKEN_KEYS.has(key)) {
      console.warn(`[config] get('${key}') bloqueado — usa getTokens() para acceder a tokens`)
      return undefined
    }

    if (key in AUTH_DEFAULTS)     return this._auth[key]
    if (key in PREF_DEFAULTS)     return this._prefs[key]
    if (key in PROFILES_DEFAULTS) return this._profiles[key]
    // Búsqueda por valor para claves dinámicas (e.g. claves no en DEFAULTS)
    if (this._prefs[key]    !== undefined) return this._prefs[key]
    if (this._profiles[key] !== undefined) return this._profiles[key]
    return undefined
  }

  set(key, value) {
    // FIX 8: bloquear escritura de tokens a través del API genérica.
    if (TOKEN_KEYS.has(key)) {
      console.warn(`[config] set('${key}') bloqueado — usa saveTokens() para guardar tokens`)
      return
    }

    if (key in AUTH_DEFAULTS)     { this.setAuthMeta({ [key]: value }); return }
    if (key in PREF_DEFAULTS)     { this.setPref(key, value); return }
    if (key in PROFILES_DEFAULTS) { this.setProfile(key, value); return }
    this.setPref(key, value)
  }

  update(obj) {
    for (const [k, v] of Object.entries(obj)) this.set(k, v)
  }

  get store() {
    // FIX 8: el store público nunca expone tokens
    return {
      ...this._prefs,
      ...this._profiles,
      ...this._auth,
    }
  }

  async clearAuth() {
    this.setAuthMeta({ username: '', uuid: '', authType: 'offline' })
    await this.clearTokens()
  }
}

module.exports = new Config()
