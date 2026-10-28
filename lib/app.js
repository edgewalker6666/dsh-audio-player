/* ============================================================================
 * dsh-audio-player — 悬浮窗运行时
 * ----------------------------------------------------------------------------
 * 独立运行在 Shadow DOM 里：
 *   - 自己的 HTMLAudioElement，与其他插件的声音互不影响；
 *   - 曲库从宿主 /dsh-audio-player/api/* 读取，MP3 落在 DSH 数据目录；
 *   - 悬浮窗可拖动、四边/右下角缩放，位置与尺寸持久化；
 *   - 启动动画模式：00:00 开始播放，动画结束事件一到就渐隐并停止。
 * ========================================================================== */

(function () {
  'use strict'

  if (window.__DSH_AUDIO_PLAYER_LOADED__) return
  window.__DSH_AUDIO_PLAYER_LOADED__ = true

  var CONF = window.__DSH_AUDIO_PLAYER_CONFIG__ || {}
  var BASE = CONF.base || '/dsh-audio-player'
  var VERSION = CONF.version || '1.0.0'
  var MAX_UPLOAD = Number(CONF.maxUpload) || 200 * 1024 * 1024
  var PANEL_KEY = 'dsh-audio-player.panel.v1'
  var ANIM_KEY = 'dsh-audio-player.last-animation.v1'

  var PANEL_DEFAULTS = {
    x: null,
    y: null,
    width: 360,
    height: 320,
    collapsed: false,
    hidden: false,
    opacity: 1
  }

  var CFG_DEFAULTS = {
    mode: 'direct',
    volume: 0.8,
    startupVolume: 0.85,
    fadeMs: 1200,
    loop: false,
    selectedTrackId: '',
    panel: PANEL_DEFAULTS
  }

  var MIN_W = 280
  var MIN_H = 200
  var MAX_W = 820
  var MAX_H = 760

  /* ── 小工具 ─────────────────────────────────────────────────────────── */

  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value))
  }

  function num(value, fallback) {
    var n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }

  function fmtTime(seconds) {
    var s = Math.max(0, Math.floor(num(seconds, 0)))
    var h = Math.floor(s / 3600)
    var m = Math.floor((s % 3600) / 60)
    var r = s % 60
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0')
    return m + ':' + String(r).padStart(2, '0')
  }

  function fmtSize(bytes) {
    var n = Math.max(0, num(bytes, 0))
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
    if (n >= 1024) return Math.round(n / 1024) + ' KB'
    return n + ' B'
  }

  function fmtSeconds(ms) {
    var s = Math.max(0, num(ms, 0)) / 1000
    return s >= 10 ? s.toFixed(1) + ' 秒' : s.toFixed(2) + ' 秒'
  }

  function mediaUrl(id) {
    return BASE + '/api/media/' + encodeURIComponent(id)
  }

  function readPanelMirror() {
    try {
      var raw = localStorage.getItem(PANEL_KEY)
      if (!raw) return null
      var parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  function writePanelMirror(panel) {
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify(panel))
    } catch {}
  }

  function readAnimMirror() {
    try {
      return num(localStorage.getItem(ANIM_KEY), 0)
    } catch {
      return 0
    }
  }

  function writeAnimMirror(ms) {
    try {
      localStorage.setItem(ANIM_KEY, String(Math.round(ms)))
    } catch {}
  }

  function loadJson(url, options) {
    return fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {}))
      .then(function (res) {
        return res.text().then(function (text) {
          if (!res.ok) {
            var message = text
            try {
              var parsed = JSON.parse(text)
              if (parsed && parsed.error) message = parsed.error
            } catch {}
            var err = new Error(message || ('HTTP ' + res.status))
            err.status = res.status
            throw err
          }
          if (!text) return {}
          return JSON.parse(text)
        })
      })
  }

  function postConfig(patch) {
    return loadJson(BASE + '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: patch })
    })
  }

  /* ── 图标 ───────────────────────────────────────────────────────────── */

  var svg = function (body, fill) {
    return '<svg viewBox="0 0 24 24" fill="' + (fill || 'none') + '" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>'
  }

  var ICONS = {
    play: svg('<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>'),
    pause: svg('<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>'),
    prev: svg('<path d="M6 5v14"/><path d="M18 6.5 8.5 12 18 17.5z" fill="currentColor" stroke="none"/>'),
    next: svg('<path d="M18 5v14"/><path d="M6 6.5 15.5 12 6 17.5z" fill="currentColor" stroke="none"/>'),
    volume: svg('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" stroke="none"/><path d="M16 8.5a5 5 0 0 1 0 7"/>'),
    mute: svg('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" stroke="none"/><path d="m16 9 5 6M21 9l-5 6"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H10a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V10a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    minus: svg('<path d="M6 12h12"/>'),
    close: svg('<path d="m7 7 10 10M17 7 7 17"/>'),
    music: svg('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),
    trash: svg('<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6.5 7l1 12h9l1-12"/><path d="M10 11v4M14 11v4"/>'),
    refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    folder: svg('<path d="M3 7h6l2 2h10v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 7V5a1 1 0 0 1 1-1h4l2 3"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>')
  }

  /* ── DOM ─────────────────────────────────────────────────────────────── */

  var host = document.createElement('div')
  host.id = 'dsh-audio-player-host'
  var shadow = host.attachShadow({ mode: 'open' })
  var style = document.createElement('style')
  style.textContent = `@@CSS@@`
  shadow.appendChild(style)

  var wrap = document.createElement('div')
  wrap.className = 'wrap'
  wrap.setAttribute('data-hidden', 'false')
  wrap.setAttribute('data-collapsed', 'false')
  wrap.innerHTML = [
    '<section class="panel" role="dialog" aria-label="DSH 音频播放器" tabindex="-1">',
    '  <header class="head" data-drag="1">',
    '    <div class="brand"><span class="dot"></span><span class="brand-name">音频播放器</span><span class="badge">MP3</span></div>',
    '    <div class="head-actions">',
    '      <button class="mode-chip" type="button" data-act="mode" title="切换播放模式">直接播放</button>',
    '      <button class="icon-btn" type="button" data-act="settings" title="设置" aria-label="设置">' + ICONS.gear + '</button>',
    '      <button class="icon-btn" type="button" data-act="collapse" title="折叠 / 展开" aria-label="折叠">' + ICONS.minus + '</button>',
    '      <button class="icon-btn" type="button" data-act="hide" title="隐藏悬浮窗" aria-label="隐藏">' + ICONS.close + '</button>',
    '    </div>',
    '  </header>',
    '  <div class="body">',
    '    <div class="now">',
    '      <div class="track-title" data-title>未选择音频</div>',
    '      <div class="track-sub" data-sub>从本地导入 MP3，或把文件拖进窗口</div>',
    '    </div>',
    '    <div class="seek-row">',
    '      <span class="time" data-cur>0:00</span>',
    '      <input class="seek" type="range" min="0" max="0.1" value="0" step="0.05" aria-label="播放进度" data-seek>',
    '      <span class="time" data-dur>0:00</span>',
    '    </div>',
    '    <div class="controls">',
    '      <button class="ctrl" type="button" data-act="prev" title="上一首" aria-label="上一首">' + ICONS.prev + '</button>',
    '      <button class="ctrl play" type="button" data-act="play" title="播放" aria-label="播放" data-play>' + ICONS.play + '</button>',
    '      <button class="ctrl" type="button" data-act="next" title="下一首" aria-label="下一首">' + ICONS.next + '</button>',
    '      <div class="volume">',
    '        <button class="icon-btn" type="button" data-act="mute" title="静音 / 恢复" aria-label="静音">' + ICONS.volume + '</button>',
    '        <input class="vol" type="range" min="0" max="100" value="80" aria-label="音量" data-vol>',
    '      </div>',
    '      <button class="import" type="button" data-act="import">' + ICONS.plus + ' 导入</button>',
    '    </div>',
    '    <div class="status" data-status>就绪</div>',
    '    <div class="tabs">',
    '      <button class="tab" type="button" data-tab="library" data-active="true">曲库<span class="count" data-count>(0)</span></button>',
    '      <button class="tab" type="button" data-tab="settings">设置</button>',
    '      <span class="spacer"></span>',
    '      <button class="mini-btn" type="button" data-act="reload" title="重新扫描 tracks 目录">刷新</button>',
    '    </div>',
    '    <div class="pane" data-pane="library"><div class="library-list" data-list></div></div>',
    '    <div class="pane" data-pane="settings" hidden>',
    '      <div class="settings">',
    '        <div class="setting">',
    '          <label for="dsh-audio-mode">播放模式</label>',
    '          <select id="dsh-audio-mode" data-set="mode">',
    '            <option value="direct">直接播放</option>',
    '            <option value="startup">启动动画同步</option>',
    '          </select>',
    '        </div>',
    '        <div class="setting">',
    '          <label>直接播放音量</label>',
    '          <input type="range" min="0" max="100" step="1" data-set="volume" aria-label="直接播放音量">',
    '          <span class="val" data-val="volume">80%</span>',
    '        </div>',
    '        <div class="setting">',
    '          <label>启动动画音量</label>',
    '          <input type="range" min="0" max="100" step="1" data-set="startupVolume" aria-label="启动动画音量">',
    '          <span class="val" data-val="startupVolume">85%</span>',
    '        </div>',
    '        <div class="setting">',
    '          <label>结束渐隐</label>',
    '          <input type="range" min="0" max="3000" step="100" data-set="fadeMs" aria-label="结束渐隐时长">',
    '          <span class="val" data-val="fadeMs">1.2s</span>',
    '        </div>',
    '        <div class="setting">',
    '          <label>直接播放循环</label>',
    '          <button class="switch" type="button" data-set="loop" aria-label="循环播放"></button>',
    '        </div>',
    '        <div class="setting">',
    '          <div class="hint">启动动画模式：选中曲目从 0:00 开始播放；动画结束的那一刻开始渐隐并停止。播放器使用独立音频元素，不会暂停、静音或改动其它插件的声音。</div>',
    '        </div>',
    '        <div class="setting">',
    '          <div class="hint">上次启动动画：<span data-last-anim>—</span></div>',
    '        </div>',
    '        <div class="setting-actions">',
    '          <button class="action-btn" type="button" data-act="reset-panel">重置窗口位置 / 大小</button>',
    '          <button class="action-btn" type="button" data-act="open-folder">' + ICONS.folder + ' 打开音频文件夹</button>',
    '          <button class="action-btn" type="button" data-act="copy-path">' + ICONS.copy + ' 复制路径</button>',
    '        </div>',
    '        <div class="path-box" data-path>—</div>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="rz" data-dir="e"></div>',
    '  <div class="rz" data-dir="s"></div>',
    '  <div class="rz" data-dir="se"></div>',
    '  <div class="drop-veil">松开以导入 MP3</div>',
    '</section>',
    '<button class="launcher" type="button" data-act="show" title="打开音频播放器" aria-label="打开音频播放器">' + ICONS.music + '</button>',
    '<input type="file" accept=".mp3,audio/mpeg" multiple hidden data-file>'
  ].join('')
  shadow.appendChild(wrap)

  var panel = wrap.querySelector('.panel')
  var titleEl = wrap.querySelector('[data-title]')
  var subEl = wrap.querySelector('[data-sub]')
  var curEl = wrap.querySelector('[data-cur]')
  var durEl = wrap.querySelector('[data-dur]')
  var seekEl = wrap.querySelector('[data-seek]')
  var volEl = wrap.querySelector('[data-vol]')
  var statusEl = wrap.querySelector('[data-status]')
  var countEl = wrap.querySelector('[data-count]')
  var listEl = wrap.querySelector('[data-list]')
  var playBtn = wrap.querySelector('[data-play]')
  var fileEl = wrap.querySelector('[data-file]')
  var modeChip = wrap.querySelector('[data-act="mode"]')
  var dotEl = wrap.querySelector('.dot')
  var launcher = wrap.querySelector('.launcher')
  var pathEl = wrap.querySelector('[data-path]')
  var lastAnimEl = wrap.querySelector('[data-last-anim]')

  if (document.body) document.body.appendChild(host)
  else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(host) }, { once: true })

  /* ── 状态 ───────────────────────────────────────────────────────────── */

  var state = {
    cfg: Object.assign({}, CFG_DEFAULTS),
    tracks: [],
    dataDir: '',
    trackDir: '',
    maxUpload: MAX_UPLOAD,
    currentId: '',
    tab: 'library',
    busy: false,
    startupActive: false,
    startupStartedAt: 0,
    startupPlaying: false,
    startupEnded: false,
    autoplayArmed: false,
    triedBlob: false,
    blobUrl: '',
    lastAnimMs: readAnimMirror(),
    statusTimer: 0,
    statusBase: '就绪',
    saveTimer: 0,
    loaded: false,
    pendingBoot: null,
    panel: Object.assign({}, PANEL_DEFAULTS, readPanelMirror() || {}),
    mountedAt: performance.now()
  }

  var audio = new Audio()
  audio.preload = 'auto'
  audio.volume = 0.8

  var uiRaf = 0
  var fadeRaf = 0

  function currentTrack() {
    for (var i = 0; i < state.tracks.length; i++) {
      if (state.tracks[i].id === state.currentId) return state.tracks[i]
    }
    return null
  }

  function trackIndex(id) {
    for (var i = 0; i < state.tracks.length; i++) {
      if (state.tracks[i].id === id) return i
    }
    return -1
  }

  /* ── 窗口几何 ───────────────────────────────────────────────────────── */

  function normalizePanel(input) {
    var src = input && typeof input === 'object' ? input : {}
    var out = Object.assign({}, PANEL_DEFAULTS)
    if (src.x !== null && src.x !== undefined && Number.isFinite(Number(src.x))) out.x = Number(src.x)
    if (src.y !== null && src.y !== undefined && Number.isFinite(Number(src.y))) out.y = Number(src.y)
    out.width = clamp(num(src.width, PANEL_DEFAULTS.width), MIN_W, MAX_W)
    out.height = clamp(num(src.height, PANEL_DEFAULTS.height), MIN_H, MAX_H)
    out.collapsed = src.collapsed === true
    out.hidden = src.hidden === true
    out.opacity = clamp(num(src.opacity, 1), 0.35, 1)
    return out
  }

  function viewportBox() {
    var vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1024)
    var vh = Math.max(240, window.innerHeight || document.documentElement.clientHeight || 768)
    return { vw: vw, vh: vh }
  }

  function clampPanel(panelCfg) {
    var box = viewportBox()
    var out = Object.assign({}, panelCfg)
    out.width = clamp(num(out.width, PANEL_DEFAULTS.width), MIN_W, Math.min(MAX_W, box.vw - 16))
    out.height = clamp(num(out.height, PANEL_DEFAULTS.height), MIN_H, Math.min(MAX_H, box.vh - 48))
    if (out.x === null || out.y === null) {
      // 首次使用 / 重置：用 right/bottom 固定在右下角，不依赖 innerWidth
      // 与窗口物理像素的换算（桌面端缩放时尤其容易算偏）。
      out.x = null
      out.y = null
      return out
    }
    var maxX = Math.max(8, box.vw - out.width - 8)
    var maxY = Math.max(40, box.vh - out.height - 8)
    out.x = clamp(out.x, 8, maxX)
    out.y = clamp(out.y, 40, maxY)
    return out
  }

  function applyPanel(panelCfg, save) {
    var next = clampPanel(normalizePanel(panelCfg))
    state.panel = next
    panel.style.width = next.width + 'px'
    panel.style.height = next.height + 'px'
    if (next.x === null || next.y === null) {
      panel.style.left = 'auto'
      panel.style.top = 'auto'
      panel.style.right = '24px'
      panel.style.bottom = '24px'
    } else {
      panel.style.left = next.x + 'px'
      panel.style.top = next.y + 'px'
      panel.style.right = 'auto'
      panel.style.bottom = 'auto'
    }
    panel.style.opacity = String(next.opacity)
    wrap.setAttribute('data-collapsed', next.collapsed ? 'true' : 'false')
    wrap.setAttribute('data-hidden', next.hidden ? 'true' : 'false')
    if (next.hidden) {
      if (next.x === null || next.y === null) {
        launcher.style.left = 'auto'
        launcher.style.top = 'auto'
        launcher.style.right = '24px'
        launcher.style.bottom = '24px'
      } else {
        var box = viewportBox()
        var lx = clamp(next.x + next.width - 52, 8, box.vw - 52)
        var ly = clamp(next.y + 10, 40, box.vh - 52)
        launcher.style.left = lx + 'px'
        launcher.style.top = ly + 'px'
        launcher.style.right = 'auto'
        launcher.style.bottom = 'auto'
      }
    }
    writePanelMirror(next)
    if (save) scheduleSave()
    return next
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer)
    state.saveTimer = setTimeout(function () {
      state.saveTimer = 0
      persistConfig()
    }, 350)
  }

  function persistConfig() {
    var patch = Object.assign({}, state.cfg)
    patch.panel = Object.assign({}, state.panel)
    postConfig(patch).catch(function (err) {
      setStatus('设置保存失败：' + err.message, 'err', 6000)
    })
  }

  function updateConfig(patch, options) {
    var opts = options || {}
    var next = Object.assign({}, state.cfg, patch)
    if (patch && patch.panel) next.panel = Object.assign({}, state.cfg.panel, patch.panel)
    state.cfg = next
    if (!state.startupActive) {
      audio.volume = clamp(num(next.volume, 0.8), 0, 1)
      audio.loop = next.loop === true
    }
    renderSettings()
    renderTransport()
    if (opts.save !== false) scheduleSave()
  }

  /* ── 渲染 ───────────────────────────────────────────────────────────── */

  function setStatus(text, tone, ttl) {
    state.statusBase = text || '就绪'
    statusEl.textContent = state.statusBase
    statusEl.setAttribute('data-tone', tone || '')
    if (state.statusTimer) clearTimeout(state.statusTimer)
    state.statusTimer = 0
    if (ttl && ttl > 0) {
      state.statusTimer = setTimeout(function () {
        state.statusTimer = 0
        statusEl.textContent = state.statusBase = defaultStatus()
        statusEl.setAttribute('data-tone', '')
      }, ttl)
    }
  }

  function defaultStatus() {
    if (state.startupActive) return state.cfg.mode === 'startup' ? '启动动画进行中 · 与动画同步' : '启动动画进行中'
    if (!audio.paused) return '正在播放 · 独立音频通道'
    return '就绪 · 独立音频通道'
  }

  function renderTrack() {
    var track = currentTrack()
    if (track) {
      titleEl.textContent = track.title || '未命名音频'
      var bits = []
      if (track.duration > 0) bits.push(fmtTime(track.duration))
      if (track.size > 0) bits.push(fmtSize(track.size))
      bits.push(track.fileName || '本地 MP3')
      subEl.textContent = bits.join(' · ')
      subEl.title = track.fileName || track.title || ''
    } else {
      titleEl.textContent = '未选择音频'
      subEl.textContent = state.tracks.length ? '在曲库中选择一首，或导入新的 MP3' : '从本地导入 MP3，或把文件拖进窗口'
      subEl.title = ''
    }
    countEl.textContent = '(' + state.tracks.length + ')'
    seekEl.disabled = !track
    playBtn.disabled = false
    pathEl.textContent = state.trackDir || state.dataDir || '—'
    lastAnimEl.textContent = state.lastAnimMs > 0 ? fmtSeconds(state.lastAnimMs) : '—'
  }

  function updateSeekUI() {
    var dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (currentTrack() ? currentTrack().duration : 0)
    var cur = Math.max(0, num(audio.currentTime, 0))
    if (!Number.isFinite(dur) || dur <= 0) dur = 0
    seekEl.max = dur > 0 ? String(dur) : '0.1'
    seekEl.value = String(dur > 0 ? Math.min(cur, dur) : 0)
    seekEl.style.setProperty('--fill', (dur > 0 ? (cur / dur) * 100 : 0) + '%')
    curEl.textContent = fmtTime(cur)
    durEl.textContent = fmtTime(dur)
    volEl.value = String(Math.round(clamp(num(audio.volume, 0.8), 0, 1) * 100))
    volEl.style.setProperty('--fill', volEl.value + '%')
  }

  function scheduleSeekUI() {
    if (uiRaf) return
    uiRaf = requestAnimationFrame(function () {
      uiRaf = 0
      updateSeekUI()
    })
  }

  function renderTransport() {
    var playing = !audio.paused && !audio.ended
    playBtn.innerHTML = playing ? ICONS.pause : ICONS.play
    playBtn.setAttribute('title', playing ? '暂停' : '播放')
    playBtn.setAttribute('aria-label', playing ? '暂停' : '播放')
    dotEl.setAttribute('data-state', state.startupActive ? 'boot' : playing ? 'playing' : 'idle')
    modeChip.textContent = state.cfg.mode === 'startup' ? '启动动画' : '直接播放'
    modeChip.setAttribute('data-mode', state.cfg.mode)
    modeChip.disabled = false
    var volumeBtn = wrap.querySelector('[data-act="mute"]')
    if (volumeBtn) volumeBtn.innerHTML = audio.volume > 0.001 ? ICONS.volume : ICONS.mute
    updateSeekUI()
  }

  function renderLibrary() {
    listEl.textContent = ''
    if (!state.tracks.length) {
      var empty = document.createElement('div')
      empty.className = 'empty'
      var strong = document.createElement('strong')
      strong.textContent = '还没有导入音频'
      var span = document.createElement('span')
      span.textContent = '点「导入」选择 MP3，或把文件拖到窗口上'
      empty.appendChild(strong)
      empty.appendChild(span)
      listEl.appendChild(empty)
      return
    }
    state.tracks.forEach(function (track, index) {
      var row = document.createElement('div')
      row.className = 'track-row'
      row.setAttribute('data-active', track.id === state.currentId ? 'true' : 'false')
      row.setAttribute('data-id', track.id)
      row.title = track.fileName || track.title

      var idx = document.createElement('span')
      idx.className = 'idx'
      idx.textContent = String(index + 1).padStart(2, '0')

      var name = document.createElement('span')
      name.className = 'name'
      name.textContent = track.title || '未命名音频'

      var dur = document.createElement('span')
      dur.className = 'dur'
      dur.textContent = track.duration > 0 ? fmtTime(track.duration) : '--:--'

      var del = document.createElement('button')
      del.className = 'del'
      del.type = 'button'
      del.title = '从 DSH 删除这首音频'
      del.setAttribute('aria-label', '删除')
      del.innerHTML = ICONS.trash
      del.addEventListener('click', function (event) {
        event.stopPropagation()
        removeTrack(track)
      })

      row.addEventListener('click', function () {
        var wasPlaying = !audio.paused && !audio.ended
        selectTrack(track.id, { autoplay: wasPlaying })
      })
      row.addEventListener('dblclick', function () {
        selectTrack(track.id, { autoplay: true })
      })

      row.appendChild(idx)
      row.appendChild(name)
      row.appendChild(dur)
      row.appendChild(del)
      listEl.appendChild(row)
    })
  }

  function renderSettings() {
    var modeSelect = wrap.querySelector('[data-set="mode"]')
    if (modeSelect) modeSelect.value = state.cfg.mode
    var volume = wrap.querySelector('[data-set="volume"]')
    if (volume) {
      volume.value = String(Math.round(clamp(num(state.cfg.volume, 0.8), 0, 1) * 100))
      volume.style.setProperty('--fill', volume.value + '%')
    }
    var startupVolume = wrap.querySelector('[data-set="startupVolume"]')
    if (startupVolume) {
      startupVolume.value = String(Math.round(clamp(num(state.cfg.startupVolume, 0.85), 0, 1) * 100))
      startupVolume.style.setProperty('--fill', startupVolume.value + '%')
    }
    var fade = wrap.querySelector('[data-set="fadeMs"]')
    if (fade) {
      fade.value = String(clamp(num(state.cfg.fadeMs, 1200), 0, 3000))
      fade.style.setProperty('--fill', (Number(fade.value) / 30) + '%')
    }
    var loop = wrap.querySelector('[data-set="loop"]')
    if (loop) loop.setAttribute('data-on', state.cfg.loop ? 'true' : 'false')
    var labels = {
      volume: Math.round(clamp(num(state.cfg.volume, 0.8), 0, 1) * 100) + '%',
      startupVolume: Math.round(clamp(num(state.cfg.startupVolume, 0.85), 0, 1) * 100) + '%',
      fadeMs: (clamp(num(state.cfg.fadeMs, 1200), 0, 3000) / 1000).toFixed(1) + 's'
    }
    Object.keys(labels).forEach(function (key) {
      var node = wrap.querySelector('[data-val="' + key + '"]')
      if (node) node.textContent = labels[key]
    })
    pathEl.textContent = state.trackDir || state.dataDir || '—'
    lastAnimEl.textContent = state.lastAnimMs > 0 ? fmtSeconds(state.lastAnimMs) : '—'
  }

  function renderAll() {
    renderTrack()
    renderLibrary()
    renderSettings()
    renderTransport()
  }

  function setTab(name) {
    state.tab = name === 'settings' ? 'settings' : 'library'
    var tabs = wrap.querySelectorAll('[data-tab]')
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('data-active', tabs[i].getAttribute('data-tab') === state.tab ? 'true' : 'false')
    }
    var panes = wrap.querySelectorAll('[data-pane]')
    for (var j = 0; j < panes.length; j++) {
      if (panes[j].getAttribute('data-pane') === state.tab) panes[j].removeAttribute('hidden')
      else panes[j].setAttribute('hidden', '')
    }
    if (state.tab === 'settings') renderSettings()
    if (state.tab === 'settings' && !state.panel.collapsed && state.panel.height < 430) {
      var expanded = applyPanel(Object.assign({}, state.panel, { height: 430 }), true)
      state.cfg.panel = Object.assign({}, state.cfg.panel, { height: expanded.height })
    }
  }

  /* ── 音频 ───────────────────────────────────────────────────────────── */

  function revokeBlob() {
    if (state.blobUrl) {
      try { URL.revokeObjectURL(state.blobUrl) } catch {}
      state.blobUrl = ''
    }
  }

  function selectTrack(id, options) {
    var opts = options || {}
    var track = null
    for (var i = 0; i < state.tracks.length; i++) {
      if (state.tracks[i].id === id) { track = state.tracks[i]; break }
    }
    if (!track) return

    state.startupPlaying = false
    state.currentId = track.id
    state.cfg.selectedTrackId = track.id
    state.triedBlob = false
    revokeBlob()

    var same = audio.getAttribute('src') === mediaUrl(track.id)
    if (!same) {
      audio.pause()
      audio.src = mediaUrl(track.id)
      audio.load()
    }
    audio.volume = clamp(num(state.startupActive ? state.cfg.startupVolume : state.cfg.volume, 0.8), 0, 1)
    audio.loop = state.startupActive ? false : state.cfg.loop === true

    renderTrack()
    renderLibrary()
    renderTransport()
    if (opts.save !== false) scheduleSave()
    if (opts.announce) setStatus('已选择：' + (track.title || '未命名音频'), '', 2600)
    if (opts.autoplay) play()
  }

  function play() {
    state.startupPlaying = false
    var track = currentTrack()
    if (!track) {
      if (state.tracks.length) {
        selectTrack(state.tracks[0].id, { autoplay: true })
      } else {
        setStatus('请先导入 MP3 音频', 'warn', 4000)
        fileEl.click()
      }
      return
    }
    if (!audio.getAttribute('src')) {
      selectTrack(track.id)
    }
    if (audio.ended) {
      try { audio.currentTime = 0 } catch {}
    }
    audio.volume = clamp(num(state.cfg.volume, 0.8), 0, 1)
    audio.loop = state.cfg.loop === true
    var promise = audio.play()
    if (promise && typeof promise.catch === 'function') {
      promise.then(function () {
        setStatus(defaultStatus(), '', 0)
        renderTransport()
      }).catch(function (err) {
        if (err && err.name === 'NotAllowedError') {
          armAutoplayUnlock('direct')
          setStatus('浏览器拦截了自动播放：点一下页面或播放器即可开始', 'warn', 7000)
        } else {
          setStatus('播放失败：' + ((err && err.message) || '未知错误'), 'err', 6000)
        }
        renderTransport()
      })
    }
  }

  function pause() {
    audio.pause()
    if (state.startupActive) state.startupPlaying = false
    stopFade(true)
    setStatus(defaultStatus(), '', 0)
    renderTransport()
  }

  function togglePlay() {
    if (audio.paused || audio.ended) play()
    else pause()
  }

  function step(delta) {
    if (!state.tracks.length) return
    var index = trackIndex(state.currentId)
    if (index < 0) index = 0
    var next = state.tracks[(index + delta + state.tracks.length) % state.tracks.length]
    if (!next) return
    var wasPlaying = !audio.paused && !audio.ended
    selectTrack(next.id, { autoplay: wasPlaying })
  }

  function armAutoplayUnlock(kind) {
    if (state.autoplayArmed) return
    state.autoplayArmed = true
    var done = function () {
      window.removeEventListener('pointerdown', done, true)
      window.removeEventListener('keydown', done, true)
      window.removeEventListener('touchstart', done, true)
      state.autoplayArmed = false
      if (kind === 'startup') {
        if (state.startupActive && !state.startupEnded && state.cfg.mode === 'startup') {
          resumeStartupAudio()
        }
      } else {
        play()
      }
    }
    window.addEventListener('pointerdown', done, true)
    window.addEventListener('keydown', done, true)
    window.addEventListener('touchstart', done, true)
  }

  function stopFade(restore) {
    if (fadeRaf) {
      cancelAnimationFrame(fadeRaf)
      fadeRaf = 0
    }
    if (restore) {
      audio.volume = clamp(num(state.cfg.volume, 0.8), 0, 1)
    }
  }

  function fadeOutAndStop(ms) {
    stopFade(false)
    if (audio.paused) {
      audio.volume = clamp(num(state.cfg.volume, 0.8), 0, 1)
      return
    }
    var base = clamp(num(audio.volume, 0.8), 0, 1)
    var duration = Math.max(0, num(ms, 0))
    if (duration <= 0) {
      audio.pause()
      audio.volume = clamp(num(state.cfg.volume, 0.8), 0, 1)
      state.startupPlaying = false
      setStatus('动画结束 · 音频已停止', '', 4500)
      renderTransport()
      return
    }
    var startedAt = performance.now()
    setStatus('动画结束 · 渐隐中…', '', 0)
    var tick = function (now) {
      var progress = clamp((now - startedAt) / duration, 0, 1)
      audio.volume = base * (1 - progress)
      if (progress < 1) {
        fadeRaf = requestAnimationFrame(tick)
        return
      }
      fadeRaf = 0
      audio.pause()
      audio.volume = clamp(num(state.cfg.volume, 0.8), 0, 1)
      state.startupPlaying = false
      setStatus('动画结束 · 音频已渐隐', '', 4500)
      renderTransport()
    }
    fadeRaf = requestAnimationFrame(tick)
  }

  function handleAudioError() {
    if (!state.currentId) return
    if (state.triedBlob) {
      setStatus('无法播放该 MP3（编码或媒体路由不可用）', 'err', 7000)
      return
    }
    state.triedBlob = true
    setStatus('媒体流不可用，改用本地 Blob 读取…', 'warn', 5000)
    fetch(mediaUrl(state.currentId), { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.blob()
      })
      .then(function (blob) {
        revokeBlob()
        state.blobUrl = URL.createObjectURL(blob)
        var wasPlaying = !audio.paused
        audio.src = state.blobUrl
        audio.load()
        if (wasPlaying) play()
      })
      .catch(function (err) {
        setStatus('读取音频失败：' + err.message, 'err', 7000)
      })
  }

  audio.addEventListener('play', function () {
    renderTransport()
    setStatus(defaultStatus(), '', 0)
  })
  audio.addEventListener('pause', function () {
    renderTransport()
    if (!state.startupActive && !state.startupEnded) setStatus(defaultStatus(), '', 0)
  })
  audio.addEventListener('ended', function () {
    state.startupPlaying = false
    if (!state.startupActive) setStatus('播放结束', '', 3500)
    renderTransport()
  })
  audio.addEventListener('timeupdate', scheduleSeekUI)
  audio.addEventListener('durationchange', scheduleSeekUI)
  audio.addEventListener('loadedmetadata', function () {
    scheduleSeekUI()
    var track = currentTrack()
    if (track && (!track.duration || Math.abs(track.duration - audio.duration) > 1) && Number.isFinite(audio.duration)) {
      track.duration = audio.duration
      loadJson(BASE + '/api/tracks/' + encodeURIComponent(track.id), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ duration: audio.duration })
      }).catch(function () {})
      renderTrack()
      if (state.tab === 'library') renderLibrary()
    }
  })
  audio.addEventListener('error', handleAudioError)

  /* ── 启动动画同步 ───────────────────────────────────────────────────── */

  function bootSnapshot() {
    return window.__DSH_AUDIO_PLAYER_BOOT__ || null
  }

  function onBootStart(event) {
    var detail = (event && event.detail) || {}
    var at = num(detail.at, performance.now())
    if (!state.loaded) {
      state.pendingBoot = { at: at, reason: detail.reason || '' }
      return
    }
    if (state.startupActive && !state.startupEnded) return
    state.startupActive = true
    state.startupEnded = false
    state.startupStartedAt = at
    state.startupPlaying = false
    renderTransport()

    if (state.cfg.mode !== 'startup') {
      setStatus('启动动画进行中', '', 2500)
      return
    }
    var track = currentTrack()
    if (!track) {
      setStatus('启动动画进行中 · 尚未选择音频', 'warn', 5000)
      return
    }
    startStartupAudio(track, at, detail.reason)
  }

  function startStartupAudio(track, startedAt, reason) {
    stopFade(true)
    state.triedBlob = false
    revokeBlob()
    state.currentId = track.id
    state.cfg.selectedTrackId = track.id
    audio.pause()
    audio.src = mediaUrl(track.id)
    audio.load()
    audio.loop = false
    audio.volume = clamp(num(state.cfg.startupVolume, 0.85), 0, 1)
    var elapsed = Math.max(0, (performance.now() - startedAt) / 1000)
    var seekTo = 0
    if (elapsed > 0.35) {
      var known = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (track.duration || 0)
      if (known > 0) seekTo = Math.min(elapsed, Math.max(0, known - 0.15))
      else seekTo = elapsed
    }
    if (seekTo > 0) {
      var applySeek = function () {
        try { audio.currentTime = seekTo } catch {}
        audio.removeEventListener('loadedmetadata', applySeek)
      }
      audio.addEventListener('loadedmetadata', applySeek)
      try { audio.currentTime = seekTo } catch {}
    }
    state.startupPlaying = true
    var promise = audio.play()
    if (promise && typeof promise.catch === 'function') {
      promise.then(function () {
        if (state.startupEnded) {
          // 动画在 play() 真正开始前就结束了：不要再补播。
          audio.pause()
          state.startupPlaying = false
          renderTransport()
          return
        }
        state.startupPlaying = true
        setStatus('启动动画同步播放中 · 结束即渐隐', '', 0)
        renderTrack()
        renderTransport()
      }).catch(function (err) {
        state.startupPlaying = false
        if (err && err.name === 'NotAllowedError') {
          armAutoplayUnlock('startup')
          setStatus('等待一次点击以开始启动音频', 'warn', 8000)
        } else {
          setStatus('启动音频播放失败：' + ((err && err.message) || err.name || '未知错误'), 'err', 7000)
        }
        renderTransport()
      })
    }
    renderTrack()
    renderTransport()
  }

  function resumeStartupAudio() {
    var track = currentTrack()
    if (!track) return
    var elapsed = Math.max(0, (performance.now() - state.startupStartedAt) / 1000)
    var known = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (track.duration || 0)
    if (known > 0) {
      try { audio.currentTime = Math.min(elapsed, Math.max(0, known - 0.15)) } catch {}
    }
    audio.volume = clamp(num(state.cfg.startupVolume, 0.85), 0, 1)
    audio.play().then(function () {
      if (state.startupEnded) {
        audio.pause()
        return
      }
      state.startupPlaying = true
      setStatus('启动动画同步播放中 · 结束即渐隐', '', 0)
      renderTransport()
    }).catch(function (err) {
      setStatus('启动音频播放失败：' + ((err && err.message) || err.name || '未知错误'), 'err', 7000)
    })
  }

  function onBootEnd(event) {
    var detail = (event && event.detail) || {}
    var durationMs = num(detail.durationMs, 0)
    if (!durationMs && state.startupStartedAt) durationMs = performance.now() - state.startupStartedAt
    state.lastAnimMs = durationMs
    writeAnimMirror(durationMs)
    if (!state.loaded) {
      state.pendingBoot = null
      state.startupEnded = true
      return
    }
    state.startupActive = false
    state.startupEnded = true
    if (state.tab === 'settings') renderSettings()
    if (!state.startupPlaying || audio.paused) {
      state.startupPlaying = false
      setStatus('启动动画结束', '', 3500)
      renderTransport()
      return
    }
    fadeOutAndStop(state.cfg.fadeMs)
    renderTransport()
  }

  function onBootSkip() {
    if (!state.loaded) {
      state.pendingBoot = null
      state.startupEnded = true
      return
    }
    if (state.startupActive) return
    state.startupActive = false
    if (state.cfg.mode === 'startup') setStatus('本次未播放启动动画', '', 3500)
    renderTransport()
  }

  function installFallbackWatcher() {
    var seenRoot = false
    var started = false
    var ended = false
    var startAt = 0
    var evaluate = function () {
      var root = document.getElementById('dsh-startup-root')
      var prts = document.documentElement.hasAttribute('data-prts-startup-active')
      if (root) {
        seenRoot = true
        if (!root.classList.contains('dsu-boot') && !started && !ended) {
          started = true
          startAt = performance.now()
          document.dispatchEvent(new CustomEvent('dsh-audio-player:startup-start', { detail: { at: startAt, reason: 'fallback' } }))
        }
        return
      }
      if (prts && !started && !ended) {
        started = true
        startAt = performance.now()
        document.dispatchEvent(new CustomEvent('dsh-audio-player:startup-start', { detail: { at: startAt, reason: 'fallback-prts' } }))
        return
      }
      if (started && !ended) {
        ended = true
        document.dispatchEvent(new CustomEvent('dsh-audio-player:startup-end', {
          detail: { at: performance.now(), startAt: startAt, durationMs: performance.now() - startAt, reason: 'fallback' }
        }))
      }
    }
    try {
      new MutationObserver(evaluate).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-prts-startup-active'],
        childList: true,
        subtree: true
      })
    } catch {}
    setInterval(evaluate, 300)
    evaluate()
    window.addEventListener('dsh-startup:done', function () {
      if (started && !ended) {
        ended = true
        document.dispatchEvent(new CustomEvent('dsh-audio-player:startup-end', {
          detail: { at: performance.now(), startAt: startAt, durationMs: performance.now() - startAt, reason: 'fallback-done' }
        }))
      }
    })
  }

  document.addEventListener('dsh-audio-player:startup-start', onBootStart)
  document.addEventListener('dsh-audio-player:startup-end', onBootEnd)
  document.addEventListener('dsh-audio-player:startup-skip', onBootSkip)
  if (!bootSnapshot()) installFallbackWatcher()

  /* ── 数据加载 ───────────────────────────────────────────────────────── */

  function mergeConfig(input) {
    var src = input && typeof input === 'object' ? input : {}
    var out = Object.assign({}, CFG_DEFAULTS, src)
    out.mode = src.mode === 'startup' ? 'startup' : 'direct'
    out.volume = clamp(num(src.volume, 0.8), 0, 1)
    out.startupVolume = clamp(num(src.startupVolume, 0.85), 0, 1)
    out.fadeMs = clamp(Math.round(num(src.fadeMs, 1200)), 0, 3000)
    out.loop = src.loop === true
    out.selectedTrackId = typeof src.selectedTrackId === 'string' ? src.selectedTrackId : ''
    out.panel = Object.assign({}, PANEL_DEFAULTS, src.panel || {})
    return out
  }

  function loadState() {
    return loadJson(BASE + '/api/state').then(function (data) {
      state.cfg = mergeConfig(data.config)
      state.tracks = Array.isArray(data.tracks) ? data.tracks : []
      state.dataDir = data.dataDir || ''
      state.trackDir = data.trackDir || ''
      state.maxUpload = num(data.maxUpload, MAX_UPLOAD)
      if (state.cfg.selectedTrackId && trackIndex(state.cfg.selectedTrackId) >= 0) {
        state.currentId = state.cfg.selectedTrackId
        audio.volume = state.cfg.volume
        audio.src = mediaUrl(state.currentId)
      } else if (state.tracks.length) {
        state.currentId = state.tracks[0].id
        state.cfg.selectedTrackId = state.currentId
        audio.volume = state.cfg.volume
        audio.src = mediaUrl(state.currentId)
        scheduleSave()
      }
      audio.loop = state.cfg.loop === true
      applyPanel(state.cfg.panel, false)
      state.loaded = true
      renderAll()
      setStatus('就绪 · 独立音频通道', '', 0)

      var snap = bootSnapshot()
      var pending = state.pendingBoot
      state.pendingBoot = null
      if (pending && !(snap && snap.ended)) {
        onBootStart({ detail: pending })
      } else if (snap) {
        if (snap.ended && snap.durationMs > 0) {
          state.lastAnimMs = snap.durationMs
          writeAnimMirror(snap.durationMs)
          renderSettings()
        } else if (snap.started && !snap.ended && !state.startupActive) {
          onBootStart({ detail: { at: snap.startAt, reason: snap.reason || 'late' } })
        } else if (snap.skipped) {
          state.startupEnded = true
        }
      }
      return data
    })
  }

  /* ── 导入 / 删除 / 刷新 ─────────────────────────────────────────────── */

  function probeDuration(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file)
      var probe = new Audio()
      var done = false
      var finish = function (value) {
        if (done) return
        done = true
        try { probe.src = '' } catch {}
        try { URL.revokeObjectURL(url) } catch {}
        resolve(value)
      }
      probe.preload = 'metadata'
      probe.addEventListener('loadedmetadata', function () {
        finish(Number.isFinite(probe.duration) ? probe.duration : 0)
      })
      probe.addEventListener('error', function () { finish(0) })
      setTimeout(function () { finish(0) }, 8000)
      probe.src = url
    })
  }

  function uploadFile(file, duration, index, total) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest()
      xhr.open('POST', BASE + '/api/tracks')
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name))
      xhr.setRequestHeader('x-duration', String(Math.max(0, Number(duration) || 0)))
      xhr.setRequestHeader('content-type', file.type || 'audio/mpeg')
      xhr.upload.onprogress = function (event) {
        if (!event.lengthComputable) return
        var pct = Math.round((event.loaded / event.total) * 100)
        setStatus('正在导入 ' + (index + 1) + '/' + total + ' · ' + file.name + ' · ' + pct + '%', '', 0)
      }
      xhr.onload = function () {
        var data = null
        try { data = JSON.parse(xhr.responseText) } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) resolve(data)
        else reject(new Error((data && data.error) || ('HTTP ' + xhr.status)))
      }
      xhr.onerror = function () { reject(new Error('网络错误')) }
      xhr.onabort = function () { reject(new Error('已取消')) }
      xhr.send(file)
    })
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (file) {
      return file && (/\.mp3$/i.test(file.name || '') || /audio\/mpeg/i.test(file.type || ''))
    })
    if (!files.length) {
      setStatus('只支持 MP3 音频文件', 'warn', 4500)
      return
    }
    if (state.busy) {
      setStatus('正在导入，请稍候…', 'warn', 3000)
      return
    }
    state.busy = true
    var importBtn = wrap.querySelector('[data-act="import"]')
    if (importBtn) importBtn.disabled = true

    var sequence = files.reduce(function (chain, file, index) {
      return chain.then(function () {
        if (file.size > state.maxUpload) {
          setStatus(file.name + ' 超过 ' + fmtSize(state.maxUpload) + ' 上限，已跳过', 'warn', 5000)
          return null
        }
        return probeDuration(file).then(function (duration) {
          return uploadFile(file, duration, index, files.length)
        }).then(function (data) {
          state.tracks = Array.isArray(data.tracks) ? data.tracks : state.tracks
          if (!state.currentId && data.track) state.currentId = data.track.id
          renderTrack()
          renderLibrary()
          return data
        }).catch(function (err) {
          setStatus('导入 ' + file.name + ' 失败：' + err.message, 'err', 6000)
          return null
        })
      })
    }, Promise.resolve())

    sequence.then(function () {
      state.busy = false
      if (importBtn) importBtn.disabled = false
      if (state.tracks.length) {
        if (!state.currentId) state.currentId = state.tracks[0].id
        state.cfg.selectedTrackId = state.currentId
        selectTrack(state.currentId, { autoplay: false, save: true })
      }
      renderAll()
      setStatus('导入完成 · 共 ' + state.tracks.length + ' 首', 'ok', 4500)
    }).catch(function (err) {
      state.busy = false
      if (importBtn) importBtn.disabled = false
      setStatus('导入失败：' + err.message, 'err', 6000)
    })
  }

  function removeTrack(track) {
    if (!track) return
    var ok = true
    try {
      ok = window.confirm('从 DSH 删除「' + (track.title || '未命名音频') + '」？\n文件也会从 tracks 目录删除。')
    } catch {
      ok = true
    }
    if (!ok) return
    loadJson(BASE + '/api/tracks/' + encodeURIComponent(track.id), { method: 'DELETE' }).then(function (data) {
      state.tracks = Array.isArray(data.tracks) ? data.tracks : state.tracks
      if (state.currentId === track.id) {
        revokeBlob()
        audio.pause()
        audio.removeAttribute('src')
        state.currentId = state.tracks[0] ? state.tracks[0].id : ''
        state.cfg.selectedTrackId = state.currentId
        if (state.currentId) selectTrack(state.currentId, { autoplay: false })
        scheduleSave()
      }
      renderAll()
      setStatus('已删除：' + (track.title || '未命名音频'), '', 3500)
    }).catch(function (err) {
      setStatus('删除失败：' + err.message, 'err', 5000)
    })
  }

  function reloadTracks() {
    setStatus('正在重新扫描 tracks 目录…', '', 0)
    loadJson(BASE + '/api/tracks/reload', { method: 'POST' }).then(function (data) {
      state.tracks = Array.isArray(data.tracks) ? data.tracks : state.tracks
      if (state.currentId && trackIndex(state.currentId) < 0) {
        state.currentId = ''
        state.cfg.selectedTrackId = ''
      }
      if (!state.currentId && state.tracks.length) {
        state.currentId = state.tracks[0].id
        state.cfg.selectedTrackId = state.currentId
        selectTrack(state.currentId, { autoplay: false })
      }
      renderAll()
      setStatus('曲库已刷新 · 新增 ' + ((data.added && data.added.length) || 0) + ' 首', 'ok', 4500)
    }).catch(function (err) {
      setStatus('刷新失败：' + err.message, 'err', 5000)
    })
  }

  /* ── 交互 ───────────────────────────────────────────────────────────── */

  function setMode(mode) {
    var next = mode === 'startup' ? 'startup' : 'direct'
    if (state.cfg.mode === next) return
    updateConfig({ mode: next })
    if (next === 'direct' && state.startupActive) {
      state.startupPlaying = false
      stopFade(true)
      audio.pause()
    }
    setStatus(next === 'startup' ? '已切换到启动动画同步模式' : '已切换到直接播放模式', '', 3500)
    renderTransport()
  }

  function showPanel() {
    updateConfig({ panel: { hidden: false } })
    applyPanel(Object.assign({}, state.panel, { hidden: false }), true)
  }

  function hidePanel() {
    updateConfig({ panel: { hidden: true } })
    applyPanel(Object.assign({}, state.panel, { hidden: true }), true)
  }

  function resetPanel() {
    var next = normalizePanel({ width: 360, height: 320, x: null, y: null, collapsed: false, hidden: false })
    applyPanel(next, true)
    updateConfig({ panel: next })
    setStatus('窗口位置与大小已重置', '', 3000)
  }

  function copyPath() {
    var text = state.trackDir || state.dataDir || ''
    if (!text) return
    var done = function () { setStatus('路径已复制到剪贴板', 'ok', 3000) }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { setStatus(text, '', 6000) })
    } else {
      setStatus(text, '', 6000)
    }
  }

  launcher.addEventListener('click', function () {
    showPanel()
  })

  panel.addEventListener('click', function (event) {
    var actNode = event.target.closest('[data-act]')
    if (!actNode || !panel.contains(actNode)) return
    var act = actNode.getAttribute('data-act')
    if (act === 'play') togglePlay()
    else if (act === 'prev') step(-1)
    else if (act === 'next') step(1)
    else if (act === 'import') fileEl.click()
    else if (act === 'mode') setMode(state.cfg.mode === 'startup' ? 'direct' : 'startup')
    else if (act === 'settings') setTab(state.tab === 'settings' ? 'library' : 'settings')
    else if (act === 'collapse') {
      var collapsed = !state.panel.collapsed
      applyPanel(Object.assign({}, state.panel, { collapsed: collapsed }), true)
      updateConfig({ panel: { collapsed: collapsed } })
    } else if (act === 'hide') hidePanel()
    else if (act === 'show') showPanel()
    else if (act === 'mute') {
      var nextVol = audio.volume > 0.001 ? 0 : clamp(num(state.cfg.volume, 0.8), 0.1, 1)
      audio.volume = nextVol
      if (!state.startupActive) updateConfig({ volume: nextVol })
      updateSeekUI()
      renderTransport()
    } else if (act === 'reload') reloadTracks()
    else if (act === 'reset-panel') resetPanel()
    else if (act === 'open-folder') {
      loadJson(BASE + '/api/reveal', { method: 'POST' }).then(function (data) {
        setStatus(data.path ? '已打开：' + data.path : '无法自动打开，路径见设置', 'ok', 5000)
      }).catch(function (err) {
        setStatus('打开文件夹失败：' + err.message, 'err', 5000)
      })
    } else if (act === 'copy-path') copyPath()
  })

  wrap.addEventListener('click', function (event) {
    var tab = event.target.closest('[data-tab]')
    if (tab && panel.contains(tab)) setTab(tab.getAttribute('data-tab'))
  })

  seekEl.addEventListener('input', function () {
    var value = num(seekEl.value, 0)
    try { audio.currentTime = value } catch {}
    updateSeekUI()
  })

  volEl.addEventListener('input', function () {
    var value = clamp(num(volEl.value, 80) / 100, 0, 1)
    audio.volume = value
    if (!state.startupActive) updateConfig({ volume: value })
    updateSeekUI()
    renderTransport()
  })

  var settingsPane = wrap.querySelector('[data-pane="settings"]')
  settingsPane.addEventListener('input', function (event) {
    var node = event.target
    var key = node.getAttribute('data-set')
    if (!key) return
    if (key === 'volume' || key === 'startupVolume') {
      var value = clamp(num(node.value, 80) / 100, 0, 1)
      if (key === 'volume') {
        audio.volume = state.startupActive ? audio.volume : value
        updateConfig({ volume: value })
      } else {
        if (state.startupActive) audio.volume = value
        updateConfig({ startupVolume: value })
      }
      renderSettings()
    } else if (key === 'fadeMs') {
      updateConfig({ fadeMs: clamp(Math.round(num(node.value, 1200)), 0, 3000) })
      renderSettings()
    }
  })

  settingsPane.addEventListener('change', function (event) {
    var node = event.target
    var key = node.getAttribute('data-set')
    if (key === 'mode') setMode(node.value)
  })

  settingsPane.addEventListener('click', function (event) {
    var node = event.target.closest('[data-set="loop"]')
    if (!node) return
    updateConfig({ loop: !state.cfg.loop })
    renderSettings()
  })

  fileEl.addEventListener('change', function () {
    handleFiles(fileEl.files)
    fileEl.value = ''
  })

  /* 拖放导入 */
  var dragDepth = 0
  ;['dragenter', 'dragover'].forEach(function (type) {
    panel.addEventListener(type, function (event) {
      event.preventDefault()
      if (event.dataTransfer && Array.prototype.indexOf.call(event.dataTransfer.types || [], 'Files') < 0) return
      if (type === 'dragenter') dragDepth += 1
      wrap.setAttribute('data-dragover', 'true')
    })
  })
  panel.addEventListener('dragleave', function (event) {
    event.preventDefault()
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) wrap.removeAttribute('data-dragover')
  })
  panel.addEventListener('drop', function (event) {
    event.preventDefault()
    dragDepth = 0
    wrap.removeAttribute('data-dragover')
    if (event.dataTransfer && event.dataTransfer.files) handleFiles(event.dataTransfer.files)
  })

  /* 拖动 */
  var drag = null
  panel.querySelector('.head').addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return
    if (event.target.closest('button,select,input,a')) return
    var rect = panel.getBoundingClientRect()
    drag = { pointer: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
    event.preventDefault()
    try { panel.querySelector('.head').setPointerCapture(event.pointerId) } catch {}
  })
  panel.querySelector('.head').addEventListener('dblclick', function (event) {
    if (event.target.closest('button,select,input,a')) return
    resetPanel()
  })

  /* 缩放 */
  var resize = null
  var resizeNodes = panel.querySelectorAll('.rz')
  for (var ri = 0; ri < resizeNodes.length; ri++) {
    resizeNodes[ri].addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      var rect = panel.getBoundingClientRect()
      resize = {
        pointer: event.pointerId,
        dir: this.getAttribute('data-dir'),
        x: event.clientX,
        y: event.clientY,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top
      }
      try { this.setPointerCapture(event.pointerId) } catch {}
    })
  }

  window.addEventListener('pointermove', function (event) {
    if (drag && event.pointerId === drag.pointer) {
      var box = viewportBox()
      var x = clamp(event.clientX - drag.dx, 8, Math.max(8, box.vw - state.panel.width - 8))
      var y = clamp(event.clientY - drag.dy, 40, Math.max(40, box.vh - state.panel.height - 8))
      panel.style.left = x + 'px'
      panel.style.top = y + 'px'
      state.panel.x = x
      state.panel.y = y
      return
    }
    if (resize && event.pointerId === resize.pointer) {
      var dir = resize.dir
      var width = resize.width
      var height = resize.height
      if (dir === 'e' || dir === 'se') width = resize.width + (event.clientX - resize.x)
      if (dir === 's' || dir === 'se') height = resize.height + (event.clientY - resize.y)
      var box2 = viewportBox()
      width = clamp(width, MIN_W, Math.min(MAX_W, box2.vw - 16))
      height = clamp(height, MIN_H, Math.min(MAX_H, box2.vh - 48))
      panel.style.width = width + 'px'
      panel.style.height = height + 'px'
      state.panel.width = width
      state.panel.height = height
    }
  })

  window.addEventListener('pointerup', function (event) {
    if (drag && event.pointerId === drag.pointer) {
      drag = null
      writePanelMirror(state.panel)
      updateConfig({ panel: { x: state.panel.x, y: state.panel.y } })
    }
    if (resize && event.pointerId === resize.pointer) {
      resize = null
      writePanelMirror(state.panel)
      updateConfig({ panel: { width: state.panel.width, height: state.panel.height } })
    }
  })

  window.addEventListener('resize', function () {
    applyPanel(state.panel, false)
  })

  shadow.addEventListener('keydown', function (event) {
    if (event.target && event.target.closest && event.target.closest('input,select,textarea')) {
      event.stopPropagation()
    }
    if (event.key === 'Escape') {
      if (state.tab === 'settings') setTab('library')
      else if (!state.panel.collapsed) {
        applyPanel(Object.assign({}, state.panel, { collapsed: true }), true)
        updateConfig({ panel: { collapsed: true } })
      }
    }
  }, true)

  /* ── 启动 ───────────────────────────────────────────────────────────── */

  applyPanel(state.panel, false)
  setTab('library')
  renderAll()
  setStatus('正在连接播放器宿主…', '', 0)

  loadState().catch(function (err) {
    setStatus('播放器宿主未响应：' + err.message + '（请刷新页面）', 'err', 0)
    renderAll()
  })

  /* 对外小 API：便于测试与后续扩展，不改变其它插件 */
  window.__DSH_AUDIO_PLAYER__ = {
    version: VERSION,
    audio: audio,
    getState: function () {
      return {
        version: VERSION,
        config: JSON.parse(JSON.stringify(state.cfg)),
        tracks: state.tracks.slice(),
        currentId: state.currentId,
        playing: !audio.paused && !audio.ended,
        currentTime: audio.currentTime,
        duration: audio.duration,
        volume: audio.volume,
        startup: {
          active: state.startupActive,
          playing: state.startupPlaying,
          ended: state.startupEnded,
          startedAt: state.startupStartedAt,
          lastDurationMs: state.lastAnimMs,
          snapshot: window.__DSH_AUDIO_PLAYER_BOOT__ ? Object.assign({}, window.__DSH_AUDIO_PLAYER_BOOT__) : null
        }
      }
    },
    play: play,
    pause: pause,
    toggle: togglePlay,
    next: function () { step(1) },
    prev: function () { step(-1) },
    select: function (id) { selectTrack(id, { autoplay: false }) },
    setMode: setMode,
    importFiles: handleFiles,
    reload: reloadTracks,
    show: showPanel,
    hide: hidePanel,
    openSettings: function () { showPanel(); setTab('settings') }
  }
})()
