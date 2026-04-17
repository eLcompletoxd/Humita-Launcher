/**
 * utils/http.js
 * HTTP helper unificado — reemplaza las funciones fetchJSON/download
 * duplicadas en installer.js, modpackManager.js y versionManager.js
 */

const https = require('https')
const http  = require('http')
const fs    = require('fs')

// ─── Errores tipados ──────────────────────────────────────────

class NetworkError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'NetworkError'
    this.code = code // 'TIMEOUT' | 'HTTP_ERROR' | 'PARSE_ERROR' | 'CONNECTION'
  }
}

class HttpError extends NetworkError {
  constructor(statusCode, url) {
    const message = _httpStatusMessage(statusCode, url)
    super(message, 'HTTP_ERROR')
    this.statusCode = statusCode
    this.url = url
  }
}

function _httpStatusMessage(status, url) {
  const host = (() => { try { return new URL(url).hostname } catch { return url } })()
  if (status === 404) return `Archivo no encontrado en ${host} (404)`
  if (status === 403) return `Acceso denegado en ${host} (403)`
  if (status === 429) return `Demasiadas solicitudes a ${host}. Intenta más tarde (429)`
  if (status >= 500)  return `El servidor ${host} tuvo un error interno (${status})`
  return `Error HTTP ${status} en ${host}`
}

// ─── fetchJSON ────────────────────────────────────────────────

/**
 * Descarga y parsea un JSON desde una URL.
 * @param {string} url
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<any>}
 */
function fetchJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http

    const req = proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJSON(res.headers.location, timeoutMs).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new HttpError(res.statusCode, url))
      }

      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          reject(new NetworkError(
            `Respuesta inválida (no es JSON) desde ${url.slice(0, 80)}`,
            'PARSE_ERROR'
          ))
        }
      })
      res.on('error', err =>
        reject(new NetworkError(`Error de red: ${err.message}`, 'CONNECTION'))
      )
    })

    req.on('error', err =>
      reject(new NetworkError(
        err.code === 'ENOTFOUND'
          ? `Sin conexión o servidor no encontrado: ${url.slice(0, 60)}`
          : `Error de conexión: ${err.message}`,
        'CONNECTION'
      ))
    )

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new NetworkError(
        `Tiempo de espera agotado (${timeoutMs / 1000}s) para ${url.slice(0, 60)}`,
        'TIMEOUT'
      ))
    })
  })
}

// ─── download ─────────────────────────────────────────────────

/**
 * Descarga un archivo a disco con manejo de progreso y errores tipados.
 * Usa un archivo .tmp que renombra al finalizar (descarga atómica).
 * @param {string} url
 * @param {string} dest  - ruta destino final
 * @param {function} [onProgress] - cb(percent: number)
 * @param {number} [timeoutMs=20000]
 * @returns {Promise<void>}
 */
function download(url, dest, onProgress, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    const tmp   = dest + '.tmp'

    // Asegurarse de que el directorio existe
    const dir = require('path').dirname(dest)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const file = fs.createWriteStream(tmp)

    const cleanup = (err) => {
      file.destroy()
      try { fs.unlinkSync(tmp) } catch {}
      reject(err)
    }

    const req = proto.get(url, (res) => {
      // Redirecciones
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.destroy()
        try { fs.unlinkSync(tmp) } catch {}
        return download(res.headers.location, dest, onProgress, timeoutMs)
          .then(resolve).catch(reject)
      }

      if (res.statusCode !== 200) {
        res.resume()
        return cleanup(new HttpError(res.statusCode, url))
      }

      const total    = parseInt(res.headers['content-length'] || '0', 10)
      let   received = 0

      res.on('data', chunk => {
        file.write(chunk)
        received += chunk.length
        if (onProgress && total > 0) {
          onProgress(Math.floor((received / total) * 100))
        }
      })

      res.on('end', () => {
        file.end(() => {
          fs.rename(tmp, dest, err => {
            if (err) return cleanup(new NetworkError(`No se pudo mover el archivo descargado: ${err.message}`, 'CONNECTION'))
            resolve()
          })
        })
      })

      res.on('error', err =>
        cleanup(new NetworkError(`Error descargando ${url.slice(0, 60)}: ${err.message}`, 'CONNECTION'))
      )
    })

    req.on('error', err =>
      cleanup(new NetworkError(
        err.code === 'ENOTFOUND'
          ? `Sin conexión al descargar ${url.slice(0, 60)}`
          : `Error de conexión: ${err.message}`,
        'CONNECTION'
      ))
    )

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      cleanup(new NetworkError(
        `Tiempo de espera agotado descargando ${url.slice(0, 60)}`,
        'TIMEOUT'
      ))
    })
  })
}

// ─── Helpers de clasificación de errores ─────────────────────

/**
 * Convierte cualquier error en un mensaje amigable para el usuario.
 * Útil para mostrar en la UI sin exponer detalles técnicos.
 * @param {Error} err
 * @returns {string}
 */
function friendlyError(err) {
  if (err instanceof NetworkError) {
    switch (err.code) {
      case 'TIMEOUT':     return `La conexión tardó demasiado. Verifica tu internet e intenta de nuevo.`
      case 'CONNECTION':  return `No se pudo conectar al servidor. Verifica tu conexión a internet.`
      case 'HTTP_ERROR':  return err.message  // ya es amigable
      case 'PARSE_ERROR': return `El servidor devolvió una respuesta inválida.`
    }
  }
  // Error genérico de Node (ENOSPC, EACCES, etc.)
  if (err.code === 'ENOSPC') return `Sin espacio en disco.`
  if (err.code === 'EACCES') return `Sin permisos para escribir en esa carpeta.`
  return err.message || 'Error desconocido'
}

/**
 * Descarga con reintentos automáticos.
 * Reintenta hasta maxRetries veces con backoff exponencial en errores de red.
 * No reintenta errores HTTP 4xx (son definitivos).
 */
async function downloadWithRetry(url, dest, onProgress, timeoutMs = 20000, maxRetries = 3) {
  let lastErr
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await download(url, dest, onProgress, timeoutMs)
      return
    } catch (err) {
      lastErr = err
      // No reintentar errores HTTP 4xx — son definitivos
      if (err instanceof HttpError && err.statusCode < 500) throw err
      if (attempt < maxRetries) {
        const wait = 1000 * attempt  // 1s, 2s, 3s
        await new Promise(r => setTimeout(r, wait))
      }
    }
  }
  throw lastErr
}

module.exports = { fetchJSON, download, downloadWithRetry, friendlyError, NetworkError, HttpError }
