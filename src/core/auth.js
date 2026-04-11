/**
 * core/auth.js
 * CAMBIOS:
 * - PUNTO 4:  tokens guardados en keychain vía config.saveTokens/getTokens
 * - PUNTO 9:  usa http.js unificado en vez de su propio helper
 * - PUNTO 13: errores de red diferenciados con friendlyError
 */

const crypto = require('crypto')
const { BrowserWindow } = require('electron')

const config              = require('../utils/config')
const { fetchJSON, friendlyError } = require('../utils/http')

// ─── Constantes Microsoft / Xbox / Minecraft ──────────────────
const MS_CLIENT_ID    = '00000000402b5328'
const MS_REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf'
const MS_SCOPE        = 'XboxLive.signin%20offline_access'

const URLS = {
  msAuth:    'https://login.live.com/oauth20_authorize.srf',
  msToken:   'https://login.live.com/oauth20_token.srf',
  xblAuth:   'https://user.auth.xboxlive.com/user/authenticate',
  xstsAuth:  'https://xsts.auth.xboxlive.com/xsts/authorize',
  mcAuth:    'https://api.minecraftservices.com/authentication/login_with_xbox',
  mcProfile: 'https://api.minecraftservices.com/minecraft/profile',
  mcOwned:   'https://api.minecraftservices.com/entitlements/mcstore',
}

// ─── HTTP helper (POST/GET con body) ──────────────────────────
// fetchJSON solo hace GET. Para los POST del flujo OAuth usamos
// este helper interno mínimo (no duplica lógica de download/assets).

const https = require('https')
const http  = require('http')

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed     = new URL(url)
    const proto      = parsed.protocol === 'https:' ? https : http
    const reqOptions = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || (body ? 'POST' : 'GET'),
      headers:  options.headers || {},
    }

    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
      reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr)
      if (!reqOptions.headers['Content-Type']) {
        reqOptions.headers['Content-Type'] = 'application/json'
      }
    }

    const req = proto.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${parsed.message || parsed.error || data}`))
          } else {
            resolve(parsed)
          }
        } catch {
          reject(new Error(`Respuesta inválida del servidor de autenticación`))
        }
      })
    })

    req.on('error', err => {
      if (err.code === 'ENOTFOUND') {
        reject(new Error('Sin conexión a internet. Verifica tu red e intenta de nuevo.'))
      } else {
        reject(new Error(`Error de conexión: ${err.message}`))
      }
    })
    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error('Tiempo de espera agotado. Verifica tu conexión e intenta de nuevo.'))
    })
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

// ─── Ventana Microsoft OAuth ──────────────────────────────────

function openMicrosoftLogin() {
  return new Promise((resolve, reject) => {
    let resolved = false

    const authUrl =
      `${URLS.msAuth}?client_id=${MS_CLIENT_ID}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(MS_REDIRECT_URI)}` +
      `&scope=${MS_SCOPE}` +
      `&prompt=select_account`

    const win = new BrowserWindow({
      width: 500,
      height: 650,
      title: 'Iniciar sesión con Microsoft',
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })

    win.loadURL(authUrl)
    win.show()

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        win.destroy()
        reject(new Error('Tiempo de espera agotado (5 min). Intenta de nuevo.'))
      }
    }, 300000)

    const checkUrl = (url) => {
      try {
        if (url.includes(MS_REDIRECT_URI)) {
          const parsed = new URL(url)
          const code   = parsed.searchParams.get('code')
          const error  = parsed.searchParams.get('error')

          if (!resolved) {
            resolved = true
            clearTimeout(timeout)

            if (error) {
              const desc = parsed.searchParams.get('error_description') || ''
              win.destroy()
              reject(new Error(`${error}: ${desc}`))
            } else if (code) {
              win.destroy()
              resolve(code)
            }
          }
          return true
        }
      } catch {}
      return false
    }

    win.webContents.on('will-redirect',      (e, url) => { if (checkUrl(url)) e.preventDefault() })
    win.webContents.on('will-navigate',      (e, url) => { if (checkUrl(url)) e.preventDefault() })
    win.webContents.on('did-navigate',       (_, url) => checkUrl(url))
    win.webContents.on('did-navigate-in-page', (_, url) => checkUrl(url))

    win.on('closed', () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        reject(new Error('Inicio de sesión cancelado.'))
      }
    })
  })
}

// ─── Flujo OAuth ──────────────────────────────────────────────

async function getMicrosoftTokens(authCode) {
  const body =
    `client_id=${MS_CLIENT_ID}` +
    `&code=${encodeURIComponent(authCode)}` +
    `&grant_type=authorization_code` +
    `&redirect_uri=${encodeURIComponent(MS_REDIRECT_URI)}`
  return request(URLS.msToken, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, body)
}

async function refreshMicrosoftToken(refreshToken) {
  const body =
    `client_id=${MS_CLIENT_ID}` +
    `&refresh_token=${encodeURIComponent(refreshToken)}` +
    `&grant_type=refresh_token` +
    `&redirect_uri=${encodeURIComponent(MS_REDIRECT_URI)}`
  return request(URLS.msToken, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, body)
}

async function authenticateXboxLive(msAccessToken) {
  const res = await request(URLS.xblAuth, {
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  })
  return { token: res.Token, userHash: res.DisplayClaims.xui[0].uhs }
}

async function authenticateXSTS(xblToken) {
  const res = await request(URLS.xstsAuth, {
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  })
  return res.Token
}

async function authenticateMinecraft(xstsToken, userHash) {
  const res = await request(URLS.mcAuth, {
    headers: { 'Content-Type': 'application/json' },
  }, { identityToken: `XBL3.0 x=${userHash};${xstsToken}` })
  return res.access_token
}

async function getMinecraftProfile(mcAccessToken) {
  return request(URLS.mcProfile, { headers: { Authorization: `Bearer ${mcAccessToken}` } })
}

async function checkMinecraftOwnership(mcAccessToken) {
  try {
    const res = await request(URLS.mcOwned, { headers: { Authorization: `Bearer ${mcAccessToken}` } })
    return res.items && res.items.some(i => i.name === 'product_minecraft' || i.name === 'game_minecraft')
  } catch {
    return true // Game Pass u otros casos donde el check falla
  }
}

// ─── Login Microsoft ──────────────────────────────────────────

async function loginMicrosoft() {
  try {
    const authCode = await openMicrosoftLogin()

    const msTokens       = await getMicrosoftTokens(authCode)
    const msAccessToken  = msTokens.access_token
    const msRefreshToken = msTokens.refresh_token

    const { token: xblToken, userHash } = await authenticateXboxLive(msAccessToken)
    const xstsToken     = await authenticateXSTS(xblToken)
    const mcAccessToken = await authenticateMinecraft(xstsToken, userHash)

    const ownsMinecraft = await checkMinecraftOwnership(mcAccessToken)
    if (!ownsMinecraft) {
      return { success: false, message: 'Esta cuenta de Microsoft no tiene Minecraft comprado.' }
    }

    const profile = await getMinecraftProfile(mcAccessToken)

    // PUNTO 4: tokens van al keychain, NO a config.json
    await config.saveTokens({ accessToken: mcAccessToken, refreshToken: msRefreshToken })

    config.setAuthMeta({ username: profile.name, uuid: profile.id, authType: 'microsoft' })

    return { success: true, username: profile.name, uuid: profile.id }

  } catch (err) {
    let message = err.message || 'Error desconocido'
    console.error('[auth] Microsoft login error:', message)

    // Códigos de error XSTS
    if (message.includes('2148916233')) message = 'Esta cuenta no tiene Xbox. Crea una en xbox.com primero.'
    if (message.includes('2148916235')) message = 'Xbox Live no está disponible en tu país.'
    if (message.includes('2148916236') || message.includes('2148916237'))
      message = 'Debes verificar tu edad en Xbox para jugar.'

    return { success: false, message }
  }
}

// ─── Refresh de sesión ────────────────────────────────────────

async function refreshSession() {
  if (config.authType !== 'microsoft') {
    return { success: true }
  }

  try {
    // PUNTO 4: tokens se leen desde keychain
    const { refreshToken } = await config.getTokens()
    if (!refreshToken) return { success: true }

    const msTokens = await refreshMicrosoftToken(refreshToken)
    const { token: xblToken, userHash } = await authenticateXboxLive(msTokens.access_token)
    const xstsToken     = await authenticateXSTS(xblToken)
    const mcAccessToken = await authenticateMinecraft(xstsToken, userHash)

    await config.saveTokens({
      accessToken:  mcAccessToken,
      refreshToken: msTokens.refresh_token || refreshToken,
    })

    return { success: true }
  } catch (err) {
    console.error('[auth] Refresh error:', err.message)
    // PUNTO 13: error diferenciado
    return { success: false, message: friendlyError(err) }
  }
}

// ─── Login offline ────────────────────────────────────────────

async function loginOffline(username) {
  if (!username || username.trim().length < 3) {
    return { success: false, message: 'El nombre debe tener al menos 3 caracteres.' }
  }
  if (username.trim().length > 16) {
    return { success: false, message: 'El nombre no puede tener más de 16 caracteres.' }
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
    return { success: false, message: 'Solo letras, números y guiones bajos.' }
  }

  const trimmed = username.trim()
  const uuid    = crypto
    .createHash('md5')
    .update('OfflinePlayer:' + trimmed)
    .digest('hex')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')

  config.setAuthMeta({ username: trimmed, uuid, authType: 'offline' })
  await config.saveTokens({ accessToken: '0', refreshToken: '' })

  return { success: true, username: trimmed }
}

// ─── Logout ───────────────────────────────────────────────────

async function logout() {
  await config.clearAuth()
  return { success: true }
}

module.exports = { loginMicrosoft, loginOffline, refreshSession, logout }
