/**
 * core/launcher.js
 * CORRECCIONES:
 * - FIX 2: javaFinder.findJava() usa spawnSync internamente, lo que
 *   bloqueaba el hilo principal de Electron varios segundos. Ahora se
 *   ejecuta dentro de un Worker thread para no congelar la UI.
 *   Si Worker no está disponible (entorno antiguo) se hace fallback al
 *   comportamiento anterior con un warning.
 */

const { spawn }  = require('child_process')
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')
const fs         = require('fs')
const path       = require('path')
const os         = require('os')

const config     = require('../utils/config')
const javaFinder = require('../utils/javaFinder')
const { getModpackDir } = require('./modpackManager')

let _process = null

// ─── FIX 2: findJava() sin bloquear el hilo principal ────────
//
// javaFinder.findJava() llama a spawnSync() en bucle, lo que puede
// tardar 1-3 segundos en Windows con muchas rutas. Ejecutarlo en el
// hilo principal congela la ventana Electron durante ese tiempo.
//
// Solución: correr la búsqueda en un Worker thread y devolver una
// Promise que resuelve cuando el worker termina.
//
// El script del worker se genera como string inline para no requerir
// un archivo extra en el proyecto.

function findJavaAsync() {
  return new Promise((resolve) => {
    // El código que ejecuta el worker (serializado como string)
    const workerScript = `
      const { parentPort } = require('worker_threads')
      const javaFinder = require(${JSON.stringify(path.resolve(__dirname, '../utils/javaFinder'))})
      const result = javaFinder.findJava()
      parentPort.postMessage(result)
    `

    let worker
    try {
      worker = new Worker(workerScript, { eval: true })
    } catch {
      // Fallback si Workers no están disponibles: bloquea el hilo,
      // pero al menos no rompe la funcionalidad.
      console.warn('[launcher] Worker threads no disponibles — findJava() ejecutándose en hilo principal')
      resolve(javaFinder.findJava())
      return
    }

    const timeout = setTimeout(() => {
      worker.terminate()
      console.warn('[launcher] findJava() timeout en worker — usando fallback')
      resolve(null)
    }, 8000)

    worker.once('message', (result) => {
      clearTimeout(timeout)
      resolve(result)
    })

    worker.once('error', () => {
      clearTimeout(timeout)
      // Si el worker falla, intentar en hilo principal como último recurso
      try { resolve(javaFinder.findJava()) } catch { resolve(null) }
    })
  })
}

// ─────────────────────────────────────────────────────────────

async function launch(versionId, serverIp, onLog, modpackId = null) {
  try {
    const mcDir = modpackId
      ? getModpackDir(modpackId)
      : config.minecraftDir

    const versionsDir = path.join(config.minecraftDir, 'versions', versionId)
    const metaPath    = path.join(versionsDir, `${versionId}.json`)

    if (!fs.existsSync(metaPath)) {
      return { success: false, message: `Versión ${versionId} no está instalada.` }
    }

    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

    // FIX 2: búsqueda de Java asíncrona (no bloquea hilo principal)
    const configuredJava = config.get('javaPath')
    const javaPath = configuredJava || await findJavaAsync()

    if (!javaPath) {
      return { success: false, message: 'Java no encontrado. Configúralo en Ajustes.' }
    }

    const { accessToken } = await config.getTokens()

    const args = buildArgs(javaPath, metadata, versionId, mcDir, serverIp, accessToken)

    fs.mkdirSync(mcDir, { recursive: true })

    onLog(`[INFO] Iniciando Minecraft ${versionId}...`)
    onLog(`[INFO] GameDir: ${mcDir}`)
    onLog(`[JAVA] ${javaPath}`)

    _process = spawn(args[0], args.slice(1), {
      cwd:   mcDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    _process.stdout.on('data', d => onLog(d.toString().trim()))
    _process.stderr.on('data', d => onLog(d.toString().trim()))

    return new Promise((resolve) => {
      _process.on('close', code => {
        _process = null
        onLog(`[INFO] Minecraft cerrado (código: ${code})`)
        resolve({ success: true, exitCode: code })
      })
      _process.on('error', err => {
        _process = null
        resolve({ success: false, message: err.message })
      })
    })

  } catch (err) {
    return { success: false, message: err.message }
  }
}

function buildArgs(javaPath, metadata, versionId, gameDir, serverIp, accessToken) {
  const ramMin   = config.get('ramMin') || '1G'
  const ramMax   = config.get('ramMax') || '2G'
  const username = config.get('username')    || 'Player'
  const uuid     = config.get('uuid')        || '00000000-0000-0000-0000-000000000000'
  const authType = config.get('authType')    || 'offline'
  const token    = accessToken || 'offline'

  const globalDir  = config.minecraftDir
  const libsDir    = path.join(globalDir, 'libraries')
  const assetsDir  = path.join(globalDir, 'assets')

  const versionsDir = path.join(globalDir, 'versions', versionId)
  const nativesDir  = path.join(versionsDir, 'natives')
  const mainClass   = metadata.mainClass || 'net.minecraft.client.main.Main'
  const assetIndex  = metadata.assetIndex?.id || versionId

  const sep       = os.platform() === 'win32' ? ';' : ':'
  const classpath = buildClasspath(metadata, libsDir, versionsDir, versionId, sep)

  const args = [
    javaPath,
    `-Xms${ramMin}`,
    `-Xmx${ramMax}`,
    `-Djava.library.path=${nativesDir}`,
    '-cp', classpath,
    mainClass,
    '--username',    username,
    '--version',     versionId,
    '--gameDir',     gameDir,
    '--assetsDir',   assetsDir,
    '--assetIndex',  assetIndex,
    '--uuid',        uuid,
    '--accessToken', token,
    '--userType',    authType === 'microsoft' ? 'msa' : 'legacy',
  ]

  if (serverIp) {
    const [host, port] = serverIp.split(':')
    args.push('--server', host)
    args.push('--port',   port || '25565')
  }

  return args
}

function buildClasspath(metadata, libsDir, versionsDir, versionId, sep) {
  const paths = []

  for (const lib of metadata.libraries || []) {
    const artifact = lib.downloads?.artifact
    if (!artifact) continue
    const p = path.join(libsDir, artifact.path)
    if (fs.existsSync(p)) paths.push(p)
  }

  const clientJar = path.join(versionsDir, `${versionId}.jar`)
  if (fs.existsSync(clientJar)) paths.push(clientJar)

  return paths.join(sep)
}

function kill() {
  if (_process) {
    _process.kill()
    _process = null
  }
}

module.exports = { launch, kill }
