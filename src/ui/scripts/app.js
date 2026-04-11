/* ═══════════════════════════════════════════
    Humita Launcher — Renderer
    CORRECCIONES:
    - FIX 11: setupLoginScreen() ahora solo registra listeners una vez.
              Al hacer logout se usa loginScreenSetup (flag) para evitar
              registrar duplicados en cada sesión.
    - FIX 5:  loadInterruptedInstalls() ahora usa mp.id en lugar de
              mp.version para evitar falsos positivos cuando varios
              modpacks comparten la misma versión de Minecraft.
   ═══════════════════════════════════════════ */

// ─── PUNTO 2: Estado global centralizado ─────────────────────

const state = {
  currentPage:      'versions',
  selectedVersion:  null,
  selectedModpack:  null,
  versions:         [],
  isInstalling:     false,
  isLaunching:      false,
  user:             null,
  interruptedInstalls: new Set(),
  offlineNotice:    '',
}

// FIX 11: flag para asegurarse de que setupLoginScreen() solo
// registra listeners una vez durante toda la vida del proceso.
let _loginScreenReady = false

// FIX: flag para que setupApp() no acumule listeners en cada login.
let _appReady = false

// FIX: referencia al handler global del popup para poder removerlo
// si fuera necesario (actualmente se registra una sola vez con _appReady).
let _popupClickHandler = null

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await window.api.config.getAll()

  if (cfg.username) {
    await loadUserState(cfg)
    showMainApp()
    setupApp()
    await loadModpacks()
  } else {
    showLoginScreen()
    setupLoginScreen()
  }
})

// ─── Pantallas ────────────────────────────────────────────────
function showLoginScreen() {
  document.getElementById('loginScreen').style.display = 'flex'
  document.getElementById('mainApp').style.display     = 'none'
}

function showMainApp() {
  document.getElementById('loginScreen').style.display = 'none'
  document.getElementById('mainApp').style.display     = 'block'
}

// ─── Cargar estado del usuario en state ───────────────────────
async function loadUserState(cfg) {
  state.user = {
    username: cfg.username,
    uuid:     cfg.uuid,
    authType: cfg.authType,
  }

  await updateSkin(cfg.username)

  const popupName = document.getElementById('userPopupName')
  const popupType = document.getElementById('userPopupType')
  if (popupName) popupName.textContent = cfg.username
  if (popupType) popupType.textContent = cfg.authType === 'microsoft' ? '🟢 Microsoft' : '🟡 Offline'

  if (cfg.lastModpackId && cfg.lastVersion) {
    state.selectedVersion = cfg.lastVersion
    state.selectedModpack = {
      id:       cfg.lastModpackId,
      name:     cfg.lastModpackName || cfg.lastVersion,
      version:  cfg.lastVersion,
      serverIp: cfg.lastServerIp || '',
    }
    updatePlayButton()
  }
}

// ─── Login Screen ─────────────────────────────────────────────

// FIX 11: se usa _loginScreenReady para garantizar que los
// addEventListener se llaman exactamente UNA vez. Antes, cada
// llamada a logout() → setupLoginScreen() duplicaba los handlers,
// causando que un click en "Microsoft" disparase el handler N veces.
function setupLoginScreen() {
  if (_loginScreenReady) return
  _loginScreenReady = true

  const btnMs      = document.getElementById('loginBtnMs')
  const btnOffline = document.getElementById('loginBtnOffline')

  btnMs.addEventListener('click', async () => {
    btnMs.disabled      = true
    btnOffline.disabled = true
    btnMs.textContent   = 'Abriendo Microsoft...'
    setLoginMsg('Se abrirá una ventana de Microsoft. Inicia sesión ahí.', 'info')

    const res = await window.api.auth.loginMicrosoft()

    btnMs.disabled      = false
    btnOffline.disabled = false
    btnMs.innerHTML     = '<span class="login-btn-icon">⊞</span> Iniciar sesión con Microsoft'

    if (res.success) {
      setLoginMsg(`¡Bienvenido, ${res.username}!`, 'success')
      const cfg = await window.api.config.getAll()
      await loadUserState(cfg)
      setTimeout(async () => { showMainApp(); setupApp(); await loadModpacks() }, 800)
    } else {
      setLoginMsg(res.message, 'error')
    }
  })

  btnOffline.addEventListener('click', () => {
    document.getElementById('offlineModal').style.display = 'flex'
    document.getElementById('offlineUsername').focus()
  })

  document.getElementById('confirmOffline').addEventListener('click', async () => {
    const username = document.getElementById('offlineUsername').value.trim()
    const res      = await window.api.auth.loginOffline(username)
    closeModal('offlineModal')

    if (res.success) {
      setLoginMsg(`¡Bienvenido, ${res.username}!`, 'success')
      const cfg = await window.api.config.getAll()
      await loadUserState(cfg)
      setTimeout(async () => { showMainApp(); setupApp(); await loadModpacks() }, 600)
    } else {
      setLoginMsg(res.message, 'error')
    }
  })

  document.getElementById('offlineUsername').addEventListener('keydown', e => {
    if (e.key === 'Enter')  document.getElementById('confirmOffline').click()
    if (e.key === 'Escape') closeModal('offlineModal')
  })
}

function setLoginMsg(msg, type = 'info') {
  const el = document.getElementById('loginMsg')
  if (!el) return
  el.textContent = msg
  el.style.color = type === 'success' ? 'var(--success)'
                 : type === 'error'   ? 'var(--error)'
                 : 'var(--text-secondary)'
}

// ─── Setup App ────────────────────────────────────────────────
function setupApp() {
  // FIX: guard para que los addEventListener no se acumulen en cada login.
  // Sin esto, cada logout → login duplica todos los handlers, y el listener
  // global de document.click del popup termina bloqueando los botones de
  // la pantalla de login en la segunda sesión.
  if (_appReady) return
  _appReady = true

  setupPlayZone()
  setupUserPopup()
  setupSettings()
  setupLogs()
  document.getElementById('refreshModpacks')?.addEventListener('click', loadModpacks)
}

// ─── Navigation ───────────────────────────────────────────────
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.getElementById(`page-${page}`)?.classList.add('active')
  state.currentPage = page
  if (page === 'settings') loadSettingsValues()
}

// ─── Skin ─────────────────────────────────────────────────────
async function updateSkin(username) {
  const url      = `https://cravatar.eu/avatar/${encodeURIComponent(username)}`
  const fallback = 'https://cravatar.eu/avatar/steve'
  ;['userSkin', 'userPopupSkin'].forEach(id => {
    const el = document.getElementById(id)
    if (el) { el.src = url; el.onerror = () => { el.src = fallback } }
  })
}

// ─── User Popup ───────────────────────────────────────────────
function setupUserPopup() {
  const chip  = document.getElementById('userChip')
  const popup = document.getElementById('userPopup')

  chip.addEventListener('click', e => {
    e.stopPropagation()
    popup.style.display = popup.style.display !== 'none' ? 'none' : 'flex'
  })
  document.addEventListener('click', () => {
    // Solo cerrar el popup si el mainApp está visible; si no,
    // el evento podría propagarse mal sobre la pantalla de login.
    if (document.getElementById('mainApp').style.display !== 'none') {
      popup.style.display = 'none'
    }
  })
  popup.addEventListener('click', e => e.stopPropagation())

  document.getElementById('popupSettings').addEventListener('click', () => {
    popup.style.display = 'none'
    navigate('settings')
  })

  document.getElementById('popupLogout').addEventListener('click', async () => {
    popup.style.display = 'none'
    await window.api.auth.logout()
    state.user            = null
    state.selectedVersion = null
    state.selectedModpack = null

    // Resetear skin
    ;['userSkin', 'userPopupSkin'].forEach(id => {
      const el = document.getElementById(id)
      if (el) el.src = 'https://cravatar.eu/avatar/steve'
    })

    // Resetear botón play
    updatePlayButton()

    // Resetear campos de la pantalla de login
    const loginMsg = document.getElementById('loginMsg')
    if (loginMsg) { loginMsg.textContent = ''; loginMsg.style.color = '' }
    const offlineInput = document.getElementById('offlineUsername')
    if (offlineInput) offlineInput.value = ''

    // Re-habilitar botones de login por si quedaron disabled de una sesión anterior
    const btnMs      = document.getElementById('loginBtnMs')
    const btnOffline = document.getElementById('loginBtnOffline')
    if (btnMs)      { btnMs.disabled = false; btnMs.innerHTML = '<span class="login-btn-icon"></span> Iniciar sesión con Microsoft' }
    if (btnOffline) btnOffline.disabled = false

    showLoginScreen()
    // FIX 11: ya NO se llama setupLoginScreen() aquí porque los listeners

    // ya están registrados desde la primera vez que se mostró la pantalla.
  })
}

// ─── Play zone ────────────────────────────────────────────────
function setupPlayZone() {
  document.getElementById('playBtn').addEventListener('click', (e) => {
    if (e.target.closest('.play-dropdown')) return
    if (state.selectedVersion && state.selectedModpack && !state.isLaunching) {
      launchGame(state.selectedVersion, state.selectedModpack.serverIp, state.selectedModpack.id)
    }
  })
}

function updatePlayButton() {
  const playVersion = document.getElementById('playVersion')
  const playBtn     = document.getElementById('playBtn')
  if (!playVersion || !playBtn) return

  if (state.selectedModpack && state.user) {
    playVersion.textContent = `${state.selectedModpack.name} · ${state.selectedModpack.version}`
    playBtn.disabled = false
  } else {
    playVersion.textContent = 'Seleccionar modpack'
    playBtn.disabled = true
  }
}

// ─── Modpacks ─────────────────────────────────────────────────

// FIX 5: se consulta por mp.id (no mp.version) para que dos modpacks
// que compartan la misma versión base de Minecraft no activen el badge
// "interrumpida" el uno por el otro.
async function loadInterruptedInstalls(modpacks) {
  state.interruptedInstalls.clear()
  for (const mp of modpacks) {
    const interrupted = await window.api.installer.hasInterrupted(mp.id)
    if (interrupted) state.interruptedInstalls.add(mp.id)
  }
}

async function loadModpacks() {
  const grid = document.getElementById('modpacksList')
  grid.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Cargando modpacks...</p></div>`

  const res = await window.api.modpacks.fetch()

  if (!res.modpacks || res.modpacks.length === 0) {
    grid.innerHTML = `<div class="loading-state"><p style="color:var(--error)">No se encontraron modpacks.</p></div>`
    return
  }

  state.versions = res.modpacks
  state.offlineNotice = res.offline
    ? `⚠ Sin conexión al servidor de modpacks. ${res.offlineReason ? `(${res.offlineReason})` : ''} Mostrando datos de ejemplo.`
    : ''

  await loadInterruptedInstalls(res.modpacks)
  renderModpackSidebar(res.modpacks)

  const targetId = state.selectedModpack?.id && res.modpacks.some(mp => mp.id === state.selectedModpack.id)
    ? state.selectedModpack.id
    : res.modpacks[0].id
  selectSidebarModpack(targetId)
}

function renderModpackSidebar(modpacks) {
  const sidebar = document.getElementById('sidebarModpacks')
  if (!sidebar) return

  sidebar.innerHTML = ''
  modpacks.forEach(mp => {
    const btn = document.createElement('button')
    btn.className = 'nav-btn nav-modpack-btn'
    btn.dataset.modpackId = mp.id
    btn.title = mp.name
    btn.innerHTML = `<span class="nav-icon">🧩</span><span class="nav-label">${mp.name}</span>`
    btn.addEventListener('click', () => selectSidebarModpack(mp.id))
    sidebar.appendChild(btn)
  })
}

function selectSidebarModpack(modpackId) {
  const mp = state.versions.find(item => item.id === modpackId)
  if (!mp) return

  selectModpack(mp)
  navigate('versions')
  updateSidebarActiveModpack(modpackId)
  renderSelectedModpack(mp)
}

function updateSidebarActiveModpack(modpackId) {
  document.querySelectorAll('.nav-modpack-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.modpackId === modpackId)
  })
}

function renderSelectedModpack(mp) {
  const grid = document.getElementById('modpacksList')
  const title = document.getElementById('modpackTitle')
  if (!grid) return

  grid.innerHTML = ''
  if (title) title.textContent = mp.name

  if (state.offlineNotice) {
    const notice = document.createElement('div')
    notice.className = 'modpack-offline-notice'
    notice.textContent = state.offlineNotice
    grid.appendChild(notice)
  }

  grid.appendChild(createModpackCard(mp))
}

function createModpackCard(mp) {
  const card      = document.createElement('div')
  card.className  = 'modpack-card'
  card.dataset.id = mp.id
  card.style.setProperty('--mp-color', mp.color || '#27ae60')

  const hasInterrupted = state.interruptedInstalls.has(mp.id)

  const logoHtml = mp.logo
    ? `<img src="${mp.logo}" class="modpack-logo" onerror="this.style.display='none'">`
    : `<div class="modpack-logo-placeholder" style="background:${mp.color || '#27ae60'}">${mp.name.charAt(0).toUpperCase()}</div>`

  const interruptedBadge = hasInterrupted
    ? `<span class="modpack-badge interrupted" title="La instalación anterior fue interrumpida. Se reanudará automáticamente.">⚠ Interrumpida</span>`
    : ''

  const installBtnText = hasInterrupted
    ? '↺ Reanudar instalación'
    : mp.installed
      ? '↺ Reinstalar'
      : '⬇ Instalar'

  card.innerHTML = `
    <div class="modpack-card-header">
      ${logoHtml}
      <div class="modpack-info">
        <div class="modpack-name">${mp.name}</div>
        <div class="modpack-version">Minecraft ${mp.version}</div>
        <div class="modpack-server">${mp.serverIp}</div>
      </div>
      ${mp.installed ? `<span class="modpack-badge installed">Instalado</span>` : ''}
      ${interruptedBadge}
    </div>
    <div class="modpack-desc">${mp.description || ''}</div>
    <div class="modpack-mods-count">${mp.mods?.length || 0} mods</div>
    <div class="modpack-actions">
      <button class="modpack-btn-install ${hasInterrupted ? 'resume' : ''}">${installBtnText}</button>
      <button class="modpack-btn-play" ${!mp.installed ? 'disabled' : ''}>▶ Jugar</button>
    </div>
  `

  card.querySelector('.modpack-btn-install').addEventListener('click', () => installModpack(mp))
  card.querySelector('.modpack-btn-play').addEventListener('click',    () => selectAndLaunchModpack(mp))

  return card
}

async function installModpack(mp) {
  if (state.isInstalling) return
  state.isInstalling = true

  const wrap  = document.getElementById('modpackProgressWrap')
  const fill  = document.getElementById('modpackProgressFill')
  const label = document.getElementById('modpackProgressLabel')

  wrap.style.display = 'block'
  fill.style.width   = '0%'
  label.style.color  = ''
  label.textContent  = state.interruptedInstalls.has(mp.id)
    ? 'Reanudando instalación anterior...'
    : 'Preparando instalación...'

  window.api.modpacks.onProgress(({ message, percent }) => {
    label.textContent = message
    fill.style.width  = `${percent}%`
  })

  const res = await window.api.modpacks.install(mp.id, mp)
  state.isInstalling = false

  if (res.success) {
    label.textContent = res.message
    fill.style.width  = '100%'
    mp.installed      = true
    state.interruptedInstalls.delete(mp.id)
    selectModpack(mp)
    setTimeout(() => { wrap.style.display = 'none'; loadModpacks() }, 2500)
  } else {
    label.style.color = 'var(--error)'
    label.textContent = res.message
    setTimeout(() => { wrap.style.display = 'none'; label.style.color = '' }, 5000)
  }
}

// ─── PUNTO 2: selectModpack actualiza state y luego la UI ────
function selectModpack(mp) {
  state.selectedVersion = mp.version
  state.selectedModpack = mp

  window.api.config.set('lastVersion',     mp.version)
  window.api.config.set('lastModpackId',   mp.id)
  window.api.config.set('lastModpackName', mp.name)
  window.api.config.set('lastServerIp',    mp.serverIp)

  updatePlayButton()
}

function selectAndLaunchModpack(mp) {
  selectModpack(mp)
  navigate('versions')
  launchGame(mp.version, mp.serverIp, mp.id)
}

// ─── Launch ───────────────────────────────────────────────────
async function launchGame(versionId, serverIp, modpackId) {
  if (state.isLaunching) return
  state.isLaunching = true

  const container    = document.getElementById('playBtn')?.closest('.play-container')
  const launchLabel  = document.getElementById('playLaunchLabel')
  const progressBar  = document.getElementById('launchProgressBar')
  const progressFill = document.getElementById('launchProgressFill')

  if (container)    container.classList.add('is-launching')
  if (launchLabel)  launchLabel.textContent = 'Lanzando'
  if (progressFill) progressFill.style.width = '0%'
  if (progressBar)  { progressBar.offsetHeight; progressBar.classList.add('visible') }

  let pct  = 5
  const tick = setInterval(() => {
    if (pct < 85) {
      pct += Math.random() * 7
      if (progressFill) progressFill.style.width = Math.min(pct, 85) + '%'
    }
  }, 350)

  window.api.launcher.onLog(line => {
    if (!launchLabel) return
    if (line.includes('Iniciando'))  launchLabel.textContent = 'Lanzando'
    if (line.includes('Loading'))    launchLabel.textContent = 'Cargando'
    if (line.includes('AUTH'))       launchLabel.textContent = 'Verificando sesión'
  })

  let res = { success: false, message: 'Error inesperado al lanzar el juego.' }

  try {
    const cfg = await window.api.config.getAll()

    if (cfg.authType === 'microsoft') {
      await Promise.race([
        window.api.auth.refresh(),
        new Promise(r => setTimeout(r, 5000)),
      ])
    }

    res = await window.api.launcher.launch(versionId, serverIp, modpackId)

  } catch (err) {
    res = { success: false, message: err.message || 'Error inesperado al lanzar el juego.' }

  } finally {
    clearInterval(tick)
    state.isLaunching = false

    if (progressFill) progressFill.style.width = '100%'

    if (!res.success) {
      const launchStatus = document.getElementById('homeStatus')
      const launchText   = document.getElementById('homeStatusText')
      if (launchStatus && launchText) {
        launchStatus.style.display = 'block'
        launchText.textContent     = `Error: ${res.message}`
        launchText.style.color     = 'var(--error)'
        setTimeout(() => {
          launchStatus.style.display = 'none'
          launchText.style.color     = ''
        }, 6000)
      }
    }

    setTimeout(() => {
      if (container)    container.classList.remove('is-launching')
      if (launchLabel)  launchLabel.textContent = 'Lanzando'
      if (progressBar)  progressBar.classList.remove('visible')
      if (progressFill) progressFill.style.width = '0%'
    }, 1000)
  }
}

// ─── Settings ─────────────────────────────────────────────────
async function loadSettingsValues() {
  const cfg = await window.api.config.getAll()
  document.getElementById('javaPath').value = cfg.javaPath     || ''
  document.getElementById('ramMin').value   = cfg.ramMin       || '1G'
  document.getElementById('ramMax').value   = cfg.ramMax       || '2G'
  document.getElementById('mcDir').value    = cfg.minecraftDir || ''
}

function setupSettings() {
  document.getElementById('detectJava').addEventListener('click', async () => {
    const note = document.getElementById('javaNote')
    note.textContent = 'Buscando Java...'
    note.style.color = ''
    const javaPath = await window.api.java.find()
    if (javaPath) {
      document.getElementById('javaPath').value = javaPath
      const version = await window.api.java.getVersion(javaPath)
      note.textContent = `Java ${version} ✓`
      note.style.color = 'var(--success)'
    } else {
      note.textContent = 'Java no encontrado. Descárgalo desde adoptium.net'
      note.style.color = 'var(--error)'
    }
  })

  document.getElementById('saveJava').addEventListener('click', async () => {
    const val  = document.getElementById('javaPath').value.trim()
    const note = document.getElementById('javaNote')
    await window.api.config.set('javaPath', val)
    note.textContent = 'Guardado ✓'
    note.style.color = 'var(--success)'
  })

  document.getElementById('saveRam').addEventListener('click', async () => {
    await window.api.config.set('ramMin', document.getElementById('ramMin').value.trim())
    await window.api.config.set('ramMax', document.getElementById('ramMax').value.trim())
  })

  document.getElementById('saveMcDir').addEventListener('click', async () => {
    await window.api.config.set('minecraftDir', document.getElementById('mcDir').value.trim())
  })
}

// ─── Logs ─────────────────────────────────────────────────────
function setupLogs() {
  const clearBtn = document.getElementById('clearLogs')
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const output = document.getElementById('logsOutput')
      if (output) output.textContent = ''
    })
  }
}

function appendLog(line) {
  const out = document.getElementById('logsOutput')
  if (!out) return
  out.textContent += line + '\n'
  out.scrollTop    = out.scrollHeight
}

// ─── Modal ────────────────────────────────────────────────────
function closeModal(id) {
  const el = document.getElementById(id)
  if (el) el.style.display = 'none'
}
