/* ═══════════════════════════════════════════
    Humita Launcher — Renderer
    MEJORAS APLICADAS:
    - Versión dinámica desde app.getVersion() (no hardcodeada en HTML)
    - CSS injection: fondo del modpack via custom property CSS, nunca interpolación directa
    - play-version con ellipsis en CSS — no desborda el botón
    - Errores de launcher/instalador persistentes hasta click manual
    - Log del juego acumulado en memoria, modal para verlo tras crash
    - Crash vs cierre normal diferenciados por exit code
    - background.png local siempre como fallback (no URL externa de Reddit)
    - Verificación de versión del modpack instalado al seleccionarlo
    - Razón offline mostrada en el aviso de banner
   ═══════════════════════════════════════════ */

const state = {
  currentModpackId:    null,
  modpacks:            [],
  isInstalling:        false,
  isLaunching:         false,
  user:                null,
  interruptedInstalls: new Set(),
  gameLog:             [],   // buffer de líneas del juego (sesión actual)
}

let _loginScreenReady = false
let _appReady         = false

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Versión dinámica desde package.json — nunca hardcodeada en HTML
  try {
    const version = await window.api.app.version()
    const el = document.getElementById('appVersion')
    if (el) el.textContent = `v${version}`
  } catch {}

  const cfg = await window.api.config.getAll()
  if (cfg.username) {
    await loadUserState(cfg)
    showMainApp()
    setupApp()
  } else {
    showLoginScreen()
    setupLoginScreen()
  }

  // Ocultar pantalla de carga con fade
  const loading = document.getElementById('loadingScreen')
  if (loading) {
    loading.classList.add('fade-out')
    setTimeout(() => loading.remove(), 400)
  }
})

function showLoginScreen() {
  document.getElementById('loginScreen').style.display = 'flex'
  document.getElementById('mainApp').style.display     = 'none'
}

function showMainApp() {
  document.getElementById('loginScreen').style.display = 'none'
  document.getElementById('mainApp').style.display     = 'block'
}

// ─── Usuario ──────────────────────────────────────────────────
async function loadUserState(cfg) {
  state.user = { username: cfg.username, uuid: cfg.uuid, authType: cfg.authType }
  await updateSkin(cfg.username)
}

async function updateSkin(username) {
  const url      = `https://cravatar.eu/avatar/${encodeURIComponent(username)}`
  const fallback = 'https://cravatar.eu/avatar/steve'
  ;['userSkin', 'profilePageSkin'].forEach(id => {
    const el = document.getElementById(id)
    if (el) { el.src = url; el.onerror = () => { el.src = fallback } }
  })
}

// ─── Login Screen ─────────────────────────────────────────────
function setupLoginScreen() {
  if (_loginScreenReady) return
  _loginScreenReady = true

  const btnMs      = document.getElementById('loginBtnMs')
  const btnOffline = document.getElementById('loginBtnOffline')

  btnMs.addEventListener('click', async () => {
    btnMs.disabled = btnOffline.disabled = true
    btnMs.textContent = 'Abriendo Microsoft...'
    setLoginMsg('Se abrirá una ventana de Microsoft. Inicia sesión ahí.', 'info')

    const res = await window.api.auth.loginMicrosoft()
    btnMs.disabled = btnOffline.disabled = false
    btnMs.innerHTML = '<img src="../../assets/microsoft.png" alt="Microsoft" class="login-btn-img"> Iniciar sesión con Microsoft'

    if (res.success) {
      setLoginMsg(`¡Bienvenido, ${res.username}!`, 'success')
      const cfg = await window.api.config.getAll()
      await loadUserState(cfg)
      setTimeout(() => { showMainApp(); setupApp() }, 800)
    } else {
      setLoginMsg(res.message, 'error')
    }
  })

  // ─── LÓGICA DE ANIMACIÓN OFFLINE ───
  function closeOfflineModalAnimated() {
    const modal = document.getElementById('offlineModal')
    if (!modal) return
    modal.classList.remove('show') // Dispara transición de salida
    setTimeout(() => {
      modal.style.display = 'none'
    }, 400) // Debe coincidir con los 0.4s del CSS
  }
  // Asignar los eventos de cierre a los nuevos IDs
  document.getElementById('closeOfflineModalBtn')?.addEventListener('click', closeOfflineModalAnimated)
  document.getElementById('cancelOfflineModalBtn')?.addEventListener('click', closeOfflineModalAnimated)
  btnOffline.addEventListener('click', () => {
    // Resetear estado del modal
    const input = document.getElementById('offlineUsername')
    const counter = document.getElementById('offlineUsernameCount')
    const hint = document.getElementById('olHint')
    const nameDisplay = document.getElementById('olUsernameDisplay')
    const skinImg = document.getElementById('olSkinHead')
    if (counter) counter.textContent = input ? input.value.length : '0'
    if (hint) { hint.textContent = 'Entre 3 y 16 caracteres. Solo letras, números y _'; hint.className = 'ol-hint' }
    if (nameDisplay) nameDisplay.textContent = (input && input.value.trim()) || 'Steve'
    if (skinImg) skinImg.src = `https://cravatar.eu/head/${encodeURIComponent((input && input.value.trim()) || 'steve')}/128`
    const modal = document.getElementById('offlineModal')
    modal.style.display = 'flex'

    // Forzar reflow para que la transición CSS funcione correctamente
    void modal.offsetWidth
    modal.classList.add('show') // Dispara transición de entrada
    if (input) setTimeout(() => input.focus(), 400) // Enfocar cuando termine la animación
  })

  // ── Skin en tiempo real mientras escribe ──
  const olInput       = document.getElementById('offlineUsername')
  const olCounter     = document.getElementById('offlineUsernameCount')
  const olNameDisplay = document.getElementById('olUsernameDisplay')
  const olSkinImg     = document.getElementById('olSkinHead')

  let _skinDebounce = null
  if (olInput) {
    olInput.addEventListener('input', () => {
      const val = olInput.value.trim()

      // Contador
      if (olCounter) olCounter.textContent = olInput.value.length

      // Nombre en tiempo real
      if (olNameDisplay) olNameDisplay.textContent = val || 'Steve'

      // Skin — debounce 600ms para no saturar cravatar
      clearTimeout(_skinDebounce)
      _skinDebounce = setTimeout(() => {
        if (olSkinImg) {
          const name = val || 'steve'
          olSkinImg.src = `https://cravatar.eu/head/${encodeURIComponent(name)}/128`
        }
      }, 600)
    })
  }

  document.getElementById('confirmOffline').addEventListener('click', async () => {
    const username = document.getElementById('offlineUsername').value.trim()
    const hint     = document.getElementById('olHint')
    const res = await window.api.auth.loginOffline(username)
    if (res.success) {
      closeOfflineModalAnimated() // Usar la animación al cerrar
      setLoginMsg(`¡Bienvenido, ${res.username}!`, 'success')
      const cfg = await window.api.config.getAll()
      await loadUserState(cfg)
      setTimeout(() => { showMainApp(); setupApp() }, 600)
    } else {
      if (hint) { hint.textContent = res.message; hint.className = 'ol-hint error' }
    }
  })
  document.getElementById('offlineUsername').addEventListener('keydown', e => {
    if (e.key === 'Enter')  document.getElementById('confirmOffline').click()
    if (e.key === 'Escape') closeOfflineModalAnimated() // Usar animación al cerrar con Esc
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
  if (_appReady) return
  _appReady = true

  setupUserPopup()
  setupSettings()
  setupPlayZone()
  loadModpacks()
}

// ─── User Profile Page ────────────────────────────────────────
function setupUserPopup() {
  const chip = document.getElementById('userChip')
  chip.addEventListener('click', e => {
    e.stopPropagation()
    openProfilePage()
  })

  // Logout desde la página de perfil
  document.getElementById('profileLogoutBtn').addEventListener('click', async () => {
    await window.api.auth.logout()
    state.user = null
    state.currentModpackId = null

    ;['userSkin', 'profilePageSkin'].forEach(id => {
      const el = document.getElementById(id)
      if (el) el.src = 'https://cravatar.eu/avatar/steve'
    })

    const loginMsg = document.getElementById('loginMsg')
    if (loginMsg) { loginMsg.textContent = ''; loginMsg.style.color = '' }
    const offlineInput = document.getElementById('offlineUsername')
    if (offlineInput) offlineInput.value = ''

    const btnMs      = document.getElementById('loginBtnMs')
    const btnOffline = document.getElementById('loginBtnOffline')
    if (btnMs) {
      btnMs.disabled = false
      btnMs.innerHTML = '<img src="../../assets/microsoft.png" alt="Microsoft" class="login-btn-img"> Iniciar sesión con Microsoft'
    }
    if (btnOffline) btnOffline.disabled = false

    showLoginScreen()
  })

  // Ajustes inline en la página de perfil
  document.getElementById('profileDetectJava').addEventListener('click', async () => {
    const note = document.getElementById('profileJavaNote')
    note.textContent = 'Buscando Java...'
    note.style.color = ''
    const javaPath = await window.api.java.find()
    if (javaPath) {
      document.getElementById('profileJavaPath').value = javaPath
      const version = await window.api.java.getVersion(javaPath)
      note.textContent = `Java ${version} ✓`
      note.style.color = 'var(--success)'
    } else {
      note.textContent = 'Java no encontrado. Descárgalo desde adoptium.net'
      note.style.color = 'var(--error)'
    }
  })

  document.getElementById('profileSaveJava').addEventListener('click', async () => {
    const val  = document.getElementById('profileJavaPath').value.trim()
    const note = document.getElementById('profileJavaNote')
    await window.api.config.set('javaPath', val)
    note.textContent = 'Guardado ✓'
    note.style.color = 'var(--success)'
    setTimeout(() => { note.textContent = ''; note.style.color = '' }, 2000)
  })

  document.getElementById('profileSaveRam').addEventListener('click', async () => {
    await window.api.config.set('ramMin', document.getElementById('profileRamMin').value.trim())
    await window.api.config.set('ramMax', document.getElementById('profileRamMax').value.trim())
    flashProfileSaved('profileSaveRam')
  })

  document.getElementById('profileSaveMcDir').addEventListener('click', async () => {
    await window.api.config.set('minecraftDir', document.getElementById('profileMcDir').value.trim())
    flashProfileSaved('profileSaveMcDir')
  })
}

function flashProfileSaved(btnId) {
  const btn = document.getElementById(btnId)
  if (!btn) return
  const orig = btn.textContent
  btn.textContent = '✓'
  setTimeout(() => { btn.textContent = orig }, 1500)
}

function openProfilePage() {
  // Llenar datos actuales
  const cfg = state.user || {}
  const username = cfg.username || '—'
  const isMs = cfg.authType === 'microsoft'

  const nameEl  = document.getElementById('profilePageName')
  const badgeEl = document.getElementById('profilePageBadge')
  const skinEl  = document.getElementById('profilePageSkin')

  if (nameEl)  nameEl.textContent  = username
  if (badgeEl) {
    badgeEl.textContent  = isMs ? 'Microsoft' : 'Offline'
    badgeEl.className    = 'profile-page-authbadge ' + (isMs ? 'ms' : 'offline')
  }
  if (skinEl) {
    const src = document.getElementById('userSkin')?.src || `https://cravatar.eu/avatar/${encodeURIComponent(username)}`
    skinEl.src = src
  }

  // Sincronizar fondo del blur con el modpack actual si existe
  const bgEl = document.getElementById('profilePageBgBlur')
  const modpackBg = document.getElementById('modpack-bg')
  if (bgEl && modpackBg) {
    const mpUrl = modpackBg.style.getPropertyValue('--modpack-bg-url')
    bgEl.style.backgroundImage = mpUrl || ''
  }

  // Cargar valores de config actuales en los campos
  window.api.config.getAll().then(cfg => {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || '' }
    set('profileJavaPath', cfg.javaPath)
    set('profileRamMin',   cfg.ramMin   || '1G')
    set('profileRamMax',   cfg.ramMax   || '2G')
    set('profileMcDir',    cfg.minecraftDir)
  })

  // Mostrar la página de perfil, ocultar la de modpack
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.getElementById('page-profile').classList.add('active')
  document.querySelectorAll('.modpack-nav-btn').forEach(b => b.classList.remove('active'))
  document.getElementById('userChip').classList.add('chip-active')

  // Quitar el fondo del modpack al entrar al perfil
  const modpackBgEl = document.getElementById('modpack-bg')
  if (modpackBgEl) modpackBgEl.classList.add('dimmed')
}

function closeProfPage() {
  document.getElementById('userChip').classList.remove('chip-active')
  const modpackBgEl = document.getElementById('modpack-bg')
  if (modpackBgEl) modpackBgEl.classList.remove('dimmed')
}

// ─── Settings modal ───────────────────────────────────────────
function openSettingsModal() {
  loadSettingsValues()
  document.getElementById('settingsModal').style.display = 'flex'
}

async function loadSettingsValues() {
  const cfg = await window.api.config.getAll()
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || '' }
  set('javaPath', cfg.javaPath)
  set('ramMin',   cfg.ramMin   || '1G')
  set('ramMax',   cfg.ramMax   || '2G')
  set('mcDir',    cfg.minecraftDir)
}

function setupSettings() {
  document.getElementById('settingsModal').addEventListener('click', function(e) {
    if (e.target === this) closeModal('settingsModal')
  })

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
    setTimeout(() => { note.textContent = ''; note.style.color = '' }, 2000)
  })

  document.getElementById('saveRam').addEventListener('click', async () => {
    await window.api.config.set('ramMin', document.getElementById('ramMin').value.trim())
    await window.api.config.set('ramMax', document.getElementById('ramMax').value.trim())
    flashSaved('saveRam')
  })

  document.getElementById('saveMcDir').addEventListener('click', async () => {
    await window.api.config.set('minecraftDir', document.getElementById('mcDir').value.trim())
    flashSaved('saveMcDir')
  })
}

function flashSaved(btnId) {
  const btn = document.getElementById(btnId)
  if (!btn) return
  const orig = btn.textContent
  btn.textContent = 'Guardado ✓'
  setTimeout(() => { btn.textContent = orig }, 1500)
}

// ─── Play zone ────────────────────────────────────────────────
function setupPlayZone() {
  document.getElementById('playBtn').addEventListener('click', () => {
    const mp = getCurrentModpack()
    if (!mp) return
    if (mp.installed) {
      if (!state.isLaunching) launchGame(mp.version, mp.serverIp, mp.id)
    } else {
      if (!state.isInstalling) installModpack(mp)
    }
  })
}

function getCurrentModpack() {
  return state.modpacks.find(m => m.id === state.currentModpackId) || null
}

// ─── Sidebar de modpacks ──────────────────────────────────────
async function loadInterruptedInstalls(modpacks) {
  state.interruptedInstalls.clear()
  for (const mp of modpacks) {
    if (await window.api.installer.hasInterrupted(mp.id))
      state.interruptedInstalls.add(mp.id)
  }
}

async function loadModpacks() {
  const nav = document.getElementById('sidebarModpackNav')
  nav.innerHTML = `<div class="sidebar-nav-loading"><div class="spinner-small"></div></div>`

  const res = await window.api.modpacks.fetch()

  if (!res.modpacks || res.modpacks.length === 0) {
    nav.innerHTML = `<div class="sidebar-nav-empty">—</div>`
    return
  }

  state.modpacks = res.modpacks
  await loadInterruptedInstalls(res.modpacks)

  // Aviso offline con razón detallada para que el usuario entienda qué pasó
  const offlineNotice = document.getElementById('offlineNotice')
  if (offlineNotice) {
    if (res.offline) {
      const reason = res.offlineReason ? ` (${res.offlineReason})` : ''
      offlineNotice.textContent = `⚠ Sin conexión al servidor de modpacks — mostrando datos locales${reason}`
      offlineNotice.style.display = 'block'
    } else {
      offlineNotice.style.display = 'none'
    }
  }

  nav.innerHTML = ''
  res.modpacks.forEach(mp => nav.appendChild(buildSidebarBtn(mp)))

  // Seleccionar último usado o el primero
  const cfg      = await window.api.config.getAll()
  const targetId = (cfg.lastModpackId && res.modpacks.find(m => m.id === cfg.lastModpackId))
    ? cfg.lastModpackId
    : res.modpacks[0].id

  selectModpack(targetId)
}

function buildSidebarBtn(mp) {
  const btn = document.createElement('button')
  btn.className  = 'nav-btn modpack-nav-btn'
  btn.dataset.id = mp.id
  btn.title      = mp.name
  btn.style.setProperty('--mp-color', mp.color || '#27ae60')

  const dotClass = mp.installed
    ? 'nav-modpack-dot installed'
    : state.interruptedInstalls.has(mp.id)
    ? 'nav-modpack-dot interrupted'
    : ''

  const iconInner = mp.logo
    ? `<img src="${mp.logo}" alt="${mp.name}"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
       <span class="nav-modpack-initial" style="display:none">${mp.name.charAt(0).toUpperCase()}</span>`
    : `<span class="nav-modpack-initial">${mp.name.charAt(0).toUpperCase()}</span>`

  btn.innerHTML = `
    <div class="nav-modpack-icon">${iconInner}</div>
    ${dotClass ? `<span class="${dotClass}"></span>` : ''}
  `
  btn.addEventListener('click', () => selectModpack(mp.id))
  return btn
}

// ─── Selección de modpack ─────────────────────────────────────
function selectModpack(modpackId) {
  state.currentModpackId = modpackId
  const mp = getCurrentModpack()
  if (!mp) return

  closeProfPage()

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.getElementById('page-modpack').classList.add('active')

  document.querySelectorAll('.modpack-nav-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.id === modpackId)
  )

  window.api.config.set('lastModpackId',   mp.id)
  window.api.config.set('lastVersion',     mp.version)
  window.api.config.set('lastModpackName', mp.name)
  window.api.config.set('lastServerIp',    mp.serverIp || '')

  // Verificar si hay una versión diferente a la que fue instalada
  checkModpackVersionMismatch(mp)

  renderModpackPage(mp)
}

// Avisa si el servidor tiene una versión diferente a la instalada localmente
async function checkModpackVersionMismatch(mp) {
  if (!mp.installed) return
  try {
    const cfg = await window.api.config.getAll()
    const installed = (cfg.installedModpacks || {})[mp.id]
    if (installed && installed.version && installed.version !== mp.version) {
      const notice = document.getElementById('offlineNotice')
      if (notice) {
        notice.textContent = `⚠ Actualización disponible: ${mp.name} ${mp.version} (instalado: ${installed.version}). Reinstala para actualizar.`
        notice.style.display = 'block'
      }
    }
  } catch {}
}

// ─── Renderizar página del modpack ────────────────────────────
function renderModpackPage(mp) {
  const hasInterrupted = state.interruptedInstalls.has(mp.id)

  // FIX CSS injection: el fondo se aplica via custom property CSS, nunca
  // interpolando datos del servidor directamente en backgroundImage.
  // La custom property es asignada como texto; el CSS la consume en #modpack-bg.
  const bgEl = document.getElementById('modpack-bg')
  if (bgEl) {
    if (mp.background && /^https?:\/\//.test(mp.background)) {
      bgEl.style.setProperty('--modpack-bg-url', `url("${mp.background.replace(/"/g, '%22')}")`)
      bgEl.classList.add('has-modpack-bg')
    } else {
      bgEl.style.removeProperty('--modpack-bg-url')
      bgEl.classList.remove('has-modpack-bg')
    }
  }

  // Logo
  const logo = document.getElementById('modpackHeroLogo')
  if (logo) {
    logo.style.background = mp.color || '#27ae60'
    // textContent es seguro; no usamos innerHTML con datos del servidor aquí
    if (mp.logo) {
      const img = document.createElement('img')
      img.src   = mp.logo
      img.alt   = mp.name
      img.onerror = () => { logo.textContent = mp.name.charAt(0).toUpperCase() }
      logo.innerHTML = ''
      logo.appendChild(img)
    } else {
      logo.textContent = mp.name.charAt(0).toUpperCase()
    }
  }

  // Textos — siempre textContent, nunca innerHTML con datos externos
  const $ = id => document.getElementById(id)
  if ($('modpackHeroName')) $('modpackHeroName').textContent = mp.name
  if ($('modpackHeroMeta')) $('modpackHeroMeta').textContent =
    `Minecraft ${mp.version}  ·  ${mp.serverIp || ''}  ·  ${mp.mods?.length || 0} mods`
  if ($('modpackHeroDesc')) $('modpackHeroDesc').textContent = mp.description || ''

  // Badges
  const badges = $('modpackHeroBadges')
  if (badges) {
    badges.innerHTML = ''
    if (mp.installed) {
      const b = document.createElement('span')
      b.className   = 'modpack-badge installed'
      b.textContent = 'Instalado'
      badges.appendChild(b)
    }
    if (hasInterrupted) {
      const b = document.createElement('span')
      b.className   = 'modpack-badge interrupted'
      b.title       = 'La instalación anterior fue interrumpida'
      b.textContent = '⚠ Interrumpida'
      badges.appendChild(b)
    }
  }

  // Versión dentro del botón JUGAR — el CSS hace el ellipsis automáticamente
  const playVersion = $('playVersion')
  if (playVersion) playVersion.textContent = `${mp.name} · ${mp.version}`

  const installBtn = $('installBtn')
  if (installBtn) installBtn.style.display = 'none'

  const playBtn = $('playBtn')
  if (mp.installed) {
    if (playBtn) {
      playBtn.disabled         = false
      playBtn.style.background = '#27ae60'
      const txt = playBtn.querySelector('.play-text')
      if (txt) txt.textContent = 'JUGAR'
    }
  } else {
    const label = hasInterrupted ? '↺ REANUDAR' : '⬇ INSTALAR'
    const color = hasInterrupted ? 'var(--warning)' : 'var(--accent)'
    if (playBtn) {
      playBtn.disabled         = false
      playBtn.style.background = color
      const txt = playBtn.querySelector('.play-text')
      if (txt) txt.textContent = label
    }
  }

  // Limpiar barras residuales de instalaciones/lanzamientos anteriores
  const heroWrap  = $('heroProgressWrap')
  const launchBar = $('launchProgressBar')
  if (heroWrap)  heroWrap.style.display = 'none'
  if (launchBar) launchBar.classList.remove('visible')
}

// ─── Instalar modpack ─────────────────────────────────────────
async function installModpack(mp) {
  if (state.isInstalling) return
  state.isInstalling = true

  const $ = id => document.getElementById(id)
  const installBtn = $('installBtn')
  const wrap  = $('heroProgressWrap')
  const fill  = $('heroProgressFill')
  const label = $('heroProgressLabel')

  if (installBtn) installBtn.style.display = 'none'
  if (wrap)  { wrap.style.display = 'block'; wrap.onclick = null; wrap.style.cursor = '' }
  if (fill)  fill.style.width   = '0%'
  if (label) {
    label.style.color = ''
    label.textContent = state.interruptedInstalls.has(mp.id)
      ? 'Reanudando instalación anterior...'
      : 'Preparando instalación...'
  }

  window.api.modpacks.onProgress(({ message, percent }) => {
    if (label) label.textContent = message
    if (fill)  fill.style.width  = `${percent}%`
  })

  const res = await window.api.modpacks.install(mp.id, mp)
  state.isInstalling = false

  if (res.success) {
    if (fill)  fill.style.width  = '100%'
    if (label) label.textContent = '¡Instalado correctamente!'

    const idx = state.modpacks.findIndex(m => m.id === mp.id)
    if (idx !== -1) state.modpacks[idx].installed = true
    state.interruptedInstalls.delete(mp.id)

    // Actualizar dot en sidebar
    const navBtn = document.querySelector(`.modpack-nav-btn[data-id="${mp.id}"]`)
    if (navBtn) {
      let dot = navBtn.querySelector('.nav-modpack-dot')
      if (!dot) { dot = document.createElement('span'); navBtn.appendChild(dot) }
      dot.className = 'nav-modpack-dot installed'
    }

    setTimeout(() => {
      if (wrap) wrap.style.display = 'none'
      renderModpackPage(state.modpacks[idx] || mp)
    }, 1500)
  } else {
    // Error persiste hasta click manual del usuario — no desaparece solo
    if (label) { label.style.color = 'var(--error)'; label.textContent = `Error: ${res.message}` }
    if (installBtn) installBtn.style.display = ''
    if (wrap) {
      wrap.title        = 'Click para cerrar'
      wrap.style.cursor = 'pointer'
      wrap.onclick      = () => {
        wrap.style.display  = 'none'
        wrap.onclick        = null
        wrap.style.cursor   = ''
        if (label) label.style.color = ''
      }
    }
  }
}

// ─── Lanzar juego ─────────────────────────────────────────────
async function launchGame(versionId, serverIp, modpackId) {
  if (state.isLaunching) return
  state.isLaunching = true
  state.gameLog     = []  // limpiar log de sesión anterior

  const $            = id => document.getElementById(id)
  const container    = $('playBtn')?.closest('.play-container')
  const launchLabel  = $('playLaunchLabel')
  const progressBar  = $('launchProgressBar')
  const progressFill = $('launchProgressFill')

  if (container)    container.classList.add('is-launching')
  if (launchLabel)  launchLabel.textContent = 'Lanzando'
  if (progressFill) progressFill.style.width = '0%'
  if (progressBar)  { progressBar.offsetHeight; progressBar.classList.add('visible') }

  let pct = 5
  const tick = setInterval(() => {
    if (pct < 85) {
      pct += Math.random() * 4
      if (progressFill) progressFill.style.width = Math.min(pct, 85) + '%'
    }
  }, 500)

  // Acumular log en memoria — disponible para el modal tras un crash
  window.api.launcher.onLog(line => {
    state.gameLog.push(line)
    if (!launchLabel) return
    if (line.includes('Iniciando')) launchLabel.textContent = 'Lanzando'
    if (line.includes('Loading'))   launchLabel.textContent = 'Cargando'
    if (line.includes('AUTH'))      launchLabel.textContent = 'Verificando sesión'
  })

  let res = { success: false, message: 'Error inesperado al lanzar el juego.' }
  try {
    const cfg = await window.api.config.getAll()
    if (cfg.authType === 'microsoft') {
      await Promise.race([window.api.auth.refresh(), new Promise(r => setTimeout(r, 5000))])
    }
    res = await window.api.launcher.launch(versionId, serverIp, modpackId)
  } catch (err) {
    res = { success: false, message: err.message || 'Error inesperado.' }
  } finally {
    clearInterval(tick)
    state.isLaunching = false
    if (progressFill) progressFill.style.width = '100%'

    // Distinguir crash (código != 0) de cierre normal
    const exitCode  = res.exitCode
    const wasCrash  = !res.success || (exitCode !== undefined && exitCode !== 0)

    if (wasCrash) {
      const launchStatus = $('homeStatus')
      const launchText   = $('homeStatusText')
      if (launchStatus && launchText) {
        // Mensaje diferenciado: crash vs. error de lanzamiento
        const msg = (!res.success && exitCode === undefined)
          ? `Error: ${res.message}`
          : `El juego se cerró inesperadamente (código ${exitCode ?? '?'}). Revisa el log.`

        launchStatus.style.display = 'block'
        launchText.textContent     = msg
        launchText.style.color     = 'var(--error)'

        // Botón "Ver log" si hay líneas acumuladas
        let logBtn = launchStatus.querySelector('.view-log-btn')
        if (!logBtn && state.gameLog.length > 0) {
          logBtn             = document.createElement('button')
          logBtn.className   = 'btn-secondary view-log-btn'
          logBtn.textContent = 'Ver log del juego'
          logBtn.style.cssText = 'margin-top:8px;font-size:11px;height:28px;padding:0 12px;display:block;'
          logBtn.onclick = (e) => { e.stopPropagation(); showGameLogModal() }
          launchStatus.appendChild(logBtn)
        }

        // Persiste hasta click manual — nunca hay setTimeout que lo borre
        launchStatus.onclick = (e) => {
          if (e.target === launchStatus || e.target === launchText) {
            // Limpiar
            const btn = launchStatus.querySelector('.view-log-btn')
            if (btn) btn.remove()
            launchStatus.style.display = 'none'
            launchText.style.color     = ''
          }
        }
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

// ─── Modal de log del juego ────────────────────────────────────
// Muestra el buffer de log acumulado en memoria durante la sesión.
// El modal se crea dinámicamente la primera vez y se reutiliza.
function showGameLogModal() {
  let modal = document.getElementById('gameLogModal')
  if (!modal) {
    modal            = document.createElement('div')
    modal.id         = 'gameLogModal'
    modal.className  = 'modal-overlay'
    modal.innerHTML  = `
      <div class="modal modal-log">
        <div class="modal-header">
          <h2>Log del juego</h2>
          <button class="modal-close-btn"
            onclick="document.getElementById('gameLogModal').style.display='none'">✕</button>
        </div>
        <pre id="gameLogContent" class="game-log-pre"></pre>
      </div>
    `
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none' })
    document.body.appendChild(modal)
  }

  const pre = document.getElementById('gameLogContent')
  if (pre) {
    pre.textContent = state.gameLog.join('\n') || '(sin salida registrada)'
    pre.scrollTop   = pre.scrollHeight
  }
  modal.style.display = 'flex'
}

// ─── Modal ────────────────────────────────────────────────────
function closeModal(id) {
  const el = document.getElementById(id)
  if (el) el.style.display = 'none'
}

// ─── Helpers para el panel offline ───────────────────────────
function _formatRamLabel(mb) {
  if (mb >= 1024) {
    const gb = mb / 1024
    return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`
  }
  return `${mb} MB`
}

function _updateSliderFill(slider) {
  const min = parseFloat(slider.min)
  const max = parseFloat(slider.max)
  const val = parseFloat(slider.value)
  const pct = ((val - min) / (max - min)) * 100
  slider.style.background = `linear-gradient(to right, var(--accent) ${pct}%, rgba(255,255,255,0.08) ${pct}%)`
}
