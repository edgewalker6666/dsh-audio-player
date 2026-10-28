/* ============================================================================
 * dsh-audio-player — Host 半侧
 * ----------------------------------------------------------------------------
 * 职责：
 *   1. 把播放器运行时注入 index.html（启动动画监听桥 + defer 脚本）
 *   2. 提供 /dsh-audio-player/* 路由：静态资源、曲库、MP3 上传、Range 流式播放
 *   3. 把用户导入的 MP3 与设置持久化到 $DSH_HOME/dsh-audio-player/
 *
 * 设计约束（对应需求）：
 *   - 音频文件真正导入 DSH 自己的目录，不是浏览器的临时 objectURL；
 *   - 播放器只创建自己的 HTMLAudioElement，不碰其它插件的 AudioContext / 语音；
 *   - 悬浮窗由独立脚本挂到 shadow DOM 上，不修改 DSH 的样式与 React 树；
 *   - 启动动画只通过 DOM 观察 + dsh-startup:done 事件感知，不阻塞动画；
 *   - 所有路由都走 connection 的浏览器信任栅栏，与系统内其它插件一致。
 * ========================================================================== */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const inject = ['webServer', 'connection']

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NS = 'dsh-audio-player'
const ROUTE_BASE = '/dsh-audio-player'

const DSH_HOME = (process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'dsh-audio-player')
const TRACK_DIR = path.join(DATA_DIR, 'tracks')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json')

const MAX_UPLOAD = 200 * 1024 * 1024
const JSON_LIMIT = 64 * 1024
const TRACK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 插件版本：优先读自己的 package.json。 */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return String(pkg.version || '').trim() || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const PANEL_DEFAULTS = {
  x: null,
  y: null,
  width: 360,
  height: 320,
  collapsed: false,
  hidden: false,
  opacity: 1
}

const DEFAULTS = {
  mode: 'direct',            // direct = 直接播放；startup = 启动动画同步播放
  volume: 0.8,               // 直接播放音量
  startupVolume: 0.85,       // 启动动画期间音量
  fadeMs: 1200,              // 动画结束后的渐隐时长
  loop: false,               // 直接播放是否循环
  selectedTrackId: '',
  panel: { ...PANEL_DEFAULTS }
}

const ENUMS = { mode: ['direct', 'startup'] }

function clampNumber(value, lo, hi, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function normalizePanel(input) {
  const src = input && typeof input === 'object' ? input : {}
  const out = { ...PANEL_DEFAULTS }
  for (const key of ['x', 'y']) {
    if (src[key] === null || src[key] === undefined) out[key] = null
    else {
      const n = Number(src[key])
      out[key] = Number.isFinite(n) ? n : null
    }
  }
  out.width = clampNumber(src.width, 280, 820, PANEL_DEFAULTS.width)
  out.height = clampNumber(src.height, 200, 760, PANEL_DEFAULTS.height)
  for (const key of ['collapsed', 'hidden']) {
    out[key] = src[key] === true || src[key] === 'true' || src[key] === 1 || src[key] === '1'
  }
  out.opacity = clampNumber(src.opacity, 0.35, 1, PANEL_DEFAULTS.opacity)
  return out
}

function normalizeConfig(input) {
  const src = input && typeof input === 'object' ? input : {}
  const out = { ...DEFAULTS, panel: { ...PANEL_DEFAULTS } }
  if (ENUMS.mode.includes(src.mode)) out.mode = src.mode
  out.volume = clampNumber(src.volume, 0, 1, DEFAULTS.volume)
  out.startupVolume = clampNumber(src.startupVolume, 0, 1, DEFAULTS.startupVolume)
  out.fadeMs = Math.round(clampNumber(src.fadeMs, 0, 4000, DEFAULTS.fadeMs))
  out.loop = src.loop === true || src.loop === 'true' || src.loop === 1 || src.loop === '1'
  out.selectedTrackId = typeof src.selectedTrackId === 'string' ? src.selectedTrackId.slice(0, 80) : ''
  out.panel = normalizePanel(src.panel)
  return out
}

function ensureDirs() {
  fs.mkdirSync(TRACK_DIR, { recursive: true })
  const readme = path.join(DATA_DIR, 'README.txt')
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      'DSH 音频播放器数据目录',
      '',
      'tracks/       导入的 MP3（删掉文件后刷新曲库即可同步）',
      'library.json  曲库索引（标题、时长、大小）',
      'config.json   播放器设置（模式、音量、渐隐、窗口位置）',
      '',
      '可以直接把 MP3 复制进 tracks/ 再点播放器的「刷新」按钮，',
      '也可以从播放器的「导入」按钮导入。',
      ''
    ].join('\r\n'), 'utf8')
  }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function readConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')))
  } catch {
    return { ...DEFAULTS, panel: { ...PANEL_DEFAULTS } }
  }
}

function writeConfig(next) {
  const cfg = normalizeConfig(next)
  ensureDirs()
  atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n')
  return cfg
}

function sanitizeTrack(track) {
  if (!track || typeof track !== 'object') return null
  const id = String(track.id || '')
  if (!TRACK_ID_RE.test(id)) return null
  const title = String(track.title || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || '未命名音频'
  return {
    id: id.toLowerCase(),
    title,
    fileName: String(track.fileName || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180),
    size: clampNumber(track.size, 0, MAX_UPLOAD, 0),
    duration: clampNumber(track.duration, 0, 24 * 3600, 0),
    addedAt: clampNumber(track.addedAt, 0, Number.MAX_SAFE_INTEGER, Date.now())
  }
}

function readLibrary() {
  try {
    const raw = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'))
    const tracks = Array.isArray(raw) ? raw : Array.isArray(raw?.tracks) ? raw.tracks : []
    return {
      version: 1,
      tracks: tracks.map(sanitizeTrack).filter(Boolean)
    }
  } catch {
    return { version: 1, tracks: [] }
  }
}

function writeLibrary(lib) {
  const clean = {
    version: 1,
    tracks: (Array.isArray(lib?.tracks) ? lib.tracks : []).map(sanitizeTrack).filter(Boolean)
  }
  ensureDirs()
  atomicWrite(LIBRARY_FILE, JSON.stringify(clean, null, 2) + '\n')
  return clean
}

function trackFilePath(id) {
  if (!TRACK_ID_RE.test(String(id || ''))) return null
  return path.join(TRACK_DIR, String(id).toLowerCase() + '.mp3')
}

function isMp3Header(buf) {
  if (!buf || buf.length < 3) return false
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true // ID3
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
}

/** 静态文件按 mtime 缓存，改完插件刷新页面即生效。 */
function makeReader(rel) {
  let cache = null
  return function read() {
    const file = path.join(PACKAGE_ROOT, rel)
    try {
      const stat = fs.statSync(file)
      if (!cache || cache.mtimeMs !== stat.mtimeMs) {
        cache = { mtimeMs: stat.mtimeMs, text: fs.readFileSync(file, 'utf8') }
      }
      return cache.text
    } catch {
      return ''
    }
  }
}

const readAppCss = makeReader('lib/app.css')
const readAppJs = makeReader('lib/app.js')

/** app.js 里的 `@@CSS@@` 占位符在服务时替换成 Shadow DOM 样式：
 *  一次请求拿到脚本 + 样式，避免悬浮窗首帧闪一下没有样式。 */
function readAppBundle() {
  return readAppJs().replace('@@CSS@@', readAppCss())
}

/* --------------------------------------------------------------------------
 * 启动动画监听桥
 * 在 <head> 里同步执行，保证比 splash.js 更早看到 DOM 状态；既不读写动画，
 * 也不改它的样式，只把「开始 / 结束 / 跳过」三个时刻记下来并派发事件。
 * 兼容：
 *   - dsh-startup-secret：#dsh-startup-root.dsu-boot → 移除 dsu-boot = 开始；
 *     root 被移除 / dsh-startup:done = 结束；
 *   - dsh-theme-prts：html[data-prts-startup-active] = 开始，属性移除 = 结束。
 * ------------------------------------------------------------------------ */
const BRIDGE_JS = `(function(){
  try {
    if (window.__DSH_AUDIO_PLAYER_BOOT__) return;
    var S = window.__DSH_AUDIO_PLAYER_BOOT__ = {
      version: 1, started: false, ended: false, skipped: false,
      seenRoot: false, startAt: 0, endAt: 0, durationMs: 0, reason: ''
    };
    function now(){ try { return performance.now() } catch(e){ return Date.now() } }
    function emit(type, detail){
      try { document.dispatchEvent(new CustomEvent(type, { detail: detail || {} })) } catch(e){}
    }
    function start(reason){
      if (S.started && !S.ended) return;
      if (S.ended) {
        S.ended = false; S.started = false; S.endAt = 0; S.durationMs = 0;
      }
      S.started = true; S.startAt = now(); S.reason = reason; S.skipped = false;
      emit('dsh-audio-player:startup-start', { at: S.startAt, reason: reason });
    }
    function end(reason){
      if (S.ended || !S.started) return;
      S.ended = true; S.endAt = now(); S.durationMs = Math.max(0, S.endAt - S.startAt);
      emit('dsh-audio-player:startup-end', {
        at: S.endAt, startAt: S.startAt, durationMs: S.durationMs, reason: reason
      });
    }
    function skip(reason){
      if (S.started || S.ended) return;
      S.skipped = true; S.reason = reason;
      emit('dsh-audio-player:startup-skip', { reason: reason });
    }
    function evaluate(){
      var root = document.getElementById('dsh-startup-root');
      var html = document.documentElement;
      var prts = !!(html && html.hasAttribute('data-prts-startup-active'));
      if (root) {
        S.seenRoot = true;
        if (root.classList && root.classList.contains('dsu-boot')) return;
        start('dsh-startup-root');
        return;
      }
      if (prts) { start('prts-theme'); return; }
      if (S.started) { end('overlay-removed'); return; }
      if (S.seenRoot && !S.skipped) skip('root-removed-before-start');
    }
    function boot(){
      evaluate();
      try {
        var mo = new MutationObserver(function(){ evaluate() });
        mo.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-prts-startup-active'],
          childList: true,
          subtree: true
        });
      } catch(e){}
      setTimeout(function(){ try { mo.disconnect() } catch(e){} }, 180000);
      var ticks = 0;
      var timer = setInterval(function(){
        ticks += 1; evaluate();
        if (ticks > 2400) clearInterval(timer);
      }, 250);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
    window.addEventListener('dsh-startup:done', function(){
      if (S.started) end('dsh-startup:done');
      else if (S.seenRoot) skip('done-without-start');
    });
  } catch (e) {}
})();`

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length)
  })
  res.end(body)
}

function sendText(res, code, type, text) {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length)
  })
  res.end(body)
}

function readJson(req, limit = JSON_LIMIT) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function decodeHeader(value) {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return ''
  try {
    return decodeURIComponent(String(raw))
  } catch {
    return String(raw)
  }
}

function titleFromFileName(name) {
  let base = ''
  try {
    base = path.basename(String(name || '').replace(/\\/g, '/'))
  } catch {
    base = String(name || '')
  }
  base = base.replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return base.slice(0, 120) || '未命名音频'
}

/** 把请求体写成 tracks/<id>.mp3，并校验 MP3 头。 */
async function receiveUpload(req) {
  const length = Number(req.headers['content-length'] || 0)
  if (Number.isFinite(length) && length > MAX_UPLOAD) {
    const err = new Error('too large')
    err.code = 'TOO_LARGE'
    throw err
  }

  const id = crypto.randomUUID()
  const tmp = path.join(TRACK_DIR, '.upload-' + crypto.randomUUID() + '.part')
  let size = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length
      if (size > MAX_UPLOAD) {
        const err = new Error('too large')
        err.code = 'TOO_LARGE'
        cb(err)
        return
      }
      cb(null, chunk)
    }
  })

  try {
    await pipeline(req, counter, fs.createWriteStream(tmp))
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }

  let header = Buffer.alloc(0)
  try {
    const fd = fs.openSync(tmp, 'r')
    try {
      header = Buffer.alloc(3)
      fs.readSync(fd, header, 0, 3, 0)
    } finally {
      fs.closeSync(fd)
    }
  } catch {}

  if (size < 128 || !isMp3Header(header)) {
    try { fs.unlinkSync(tmp) } catch {}
    const err = new Error('not an mp3')
    err.code = 'NOT_MP3'
    throw err
  }

  const target = trackFilePath(id)
  fs.renameSync(tmp, target)
  return { id, size, file: target }
}

function parseRange(header, size) {
  const raw = String(header || '').trim()
  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw)
  if (!match) return null
  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''
  if (!hasStart && !hasEnd) return null

  let start
  let end
  if (!hasStart) {
    const suffix = Number(match[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = hasEnd ? Number(match[2]) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start >= size || end < start) return null
  end = Math.min(end, size - 1)
  return { start, end }
}

function streamMedia(req, res, file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    sendJson(res, 404, { ok: false, error: 'track file missing' })
    return
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { ok: false, error: 'track file missing' })
    return
  }

  const baseHeaders = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': 'inline'
  }

  const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null
  if (req.headers.range && !range) {
    res.writeHead(416, {
      ...baseHeaders,
      'Content-Range': 'bytes */' + stat.size,
      'Content-Length': '0'
    })
    res.end()
    return
  }

  if (range) {
    const { start, end } = range
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Content-Length': String(end - start + 1)
    })
    if ((req.method || 'GET').toUpperCase() === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(file, { start, end })
    stream.on('error', () => { try { res.destroy() } catch {} })
    req.on('close', () => { try { stream.destroy() } catch {} })
    stream.pipe(res)
    return
  }

  res.writeHead(200, {
    ...baseHeaders,
    'Content-Length': String(stat.size)
  })
  if ((req.method || 'GET').toUpperCase() === 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(file)
  stream.on('error', () => { try { res.destroy() } catch {} })
  req.on('close', () => { try { stream.destroy() } catch {} })
  stream.pipe(res)
}

function openDataFolder() {
  ensureDirs()
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [TRACK_DIR], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(cmd, [TRACK_DIR], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

function apply(ctx) {
  ensureDirs()

  const webServer = (() => {
    try {
      const viaGet = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      if (viaGet) return viaGet
    } catch {}
    return ctx.webServer
  })()

  if (!webServer || typeof webServer.register !== 'function') {
    try {
      ctx.logger?.warn?.('[' + NS + '] 当前 profile 没有可用的 webServer，宿主侧跳过路由与 index 注入。')
    } catch {}
    return
  }

  function rejected(req, res) {
    try {
      const connection = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
      if (!connection || typeof connection.requestRejection !== 'function') return false
      const code = connection.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.setHeader('Cache-Control', 'no-store')
      res.end()
      return true
    } catch {
      return false
    }
  }

  async function handle(req, res) {
    if (rejected(req, res)) return

    let pathname = '/'
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname)
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad url' })
      return
    }

    const method = (req.method || 'GET').toUpperCase()

    if (pathname === ROUTE_BASE + '/app.css') {
      sendText(res, 200, 'text/css; charset=utf-8', readAppCss())
      return
    }
    if (pathname === ROUTE_BASE + '/app.js') {
      sendText(res, 200, 'application/javascript; charset=utf-8', readAppBundle())
      return
    }

    if (pathname === ROUTE_BASE + '/api/health') {
      const lib = readLibrary()
      sendJson(res, 200, {
        ok: true,
        name: NS,
        version: VERSION,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        tracks: lib.tracks.length,
        dataDir: DATA_DIR,
        trackDir: TRACK_DIR,
        maxUpload: MAX_UPLOAD
      })
      return
    }

    if (pathname === ROUTE_BASE + '/api/state' && method === 'GET') {
      const cfg = readConfig()
      const lib = readLibrary()
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        config: cfg,
        tracks: lib.tracks,
        dataDir: DATA_DIR,
        trackDir: TRACK_DIR,
        maxUpload: MAX_UPLOAD,
        platform: process.platform
      })
      return
    }

    if (pathname === ROUTE_BASE + '/api/config' && method === 'POST') {
      const payload = await readJson(req)
      if (payload === null) {
        sendJson(res, 400, { ok: false, error: 'invalid json' })
        return
      }
      const current = readConfig()
      const patch = payload && typeof payload.patch === 'object' && payload.patch ? payload.patch : payload
      const nextInput = { ...current, ...patch }
      if (patch && typeof patch.panel === 'object' && patch.panel) {
        nextInput.panel = { ...current.panel, ...patch.panel }
      }
      const cfg = writeConfig(nextInput)
      sendJson(res, 200, { ok: true, config: cfg })
      return
    }

    if (pathname === ROUTE_BASE + '/api/tracks' && method === 'POST') {
      let upload
      try {
        upload = await receiveUpload(req)
      } catch (err) {
        if (err && err.code === 'TOO_LARGE') {
          sendJson(res, 413, { ok: false, error: 'file too large', maxUpload: MAX_UPLOAD })
          return
        }
        if (err && err.code === 'NOT_MP3') {
          sendJson(res, 415, { ok: false, error: 'not an mp3 file' })
          return
        }
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        return
      }

      const fileName = decodeHeader(req.headers['x-file-name'])
      const duration = clampNumber(req.headers['x-duration'], 0, 24 * 3600, 0)
      const track = sanitizeTrack({
        id: upload.id,
        title: titleFromFileName(fileName),
        fileName,
        size: upload.size,
        duration,
        addedAt: Date.now()
      })

      const lib = readLibrary()
      lib.tracks.unshift(track)
      writeLibrary(lib)

      const cfg = readConfig()
      if (!cfg.selectedTrackId) writeConfig({ ...cfg, selectedTrackId: track.id })

      sendJson(res, 200, { ok: true, track, tracks: lib.tracks })
      return
    }

    if (pathname === ROUTE_BASE + '/api/tracks/reload' && method === 'POST') {
      // 重新扫描 tracks/，把用户手工复制进来的 MP3 也纳入曲库。
      const lib = readLibrary()
      // 曲库里记录但文件已被手工删掉的条目也一并清掉。
      lib.tracks = lib.tracks.filter((track) => {
        const file = trackFilePath(track.id)
        try {
          return !!file && fs.existsSync(file)
        } catch {
          return false
        }
      })
      const known = new Set(lib.tracks.map((t) => t.id))
      const added = []
      let entries = []
      try {
        entries = fs.readdirSync(TRACK_DIR)
      } catch {}
      for (const entry of entries) {
        if (!entry.toLowerCase().endsWith('.mp3')) continue
        if (entry.startsWith('.upload-')) continue
        let id = entry.slice(0, -4).toLowerCase()
        let fileName = entry
        if (!TRACK_ID_RE.test(id)) {
          // 手工复制进来的 MP3 不一定是 UUID 文件名：分配一个 id 并改名，
          // 这样「把文件丢进 tracks/ 再点刷新」也能用。
          const nextId = crypto.randomUUID()
          try {
            fs.renameSync(path.join(TRACK_DIR, entry), path.join(TRACK_DIR, nextId + '.mp3'))
          } catch {
            continue
          }
          id = nextId
        }
        if (known.has(id)) continue
        let stat
        try {
          stat = fs.statSync(path.join(TRACK_DIR, id + '.mp3'))
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        const track = sanitizeTrack({
          id,
          title: titleFromFileName(fileName),
          fileName,
          size: stat.size,
          duration: 0,
          addedAt: stat.mtimeMs
        })
        if (!track) continue
        lib.tracks.push(track)
        added.push(track)
        known.add(id)
      }
      writeLibrary(lib)
      sendJson(res, 200, { ok: true, added, tracks: lib.tracks })
      return
    }

    if (pathname === ROUTE_BASE + '/api/reveal' && method === 'POST') {
      const opened = openDataFolder()
      sendJson(res, 200, { ok: opened, path: TRACK_DIR })
      return
    }

    if (pathname.startsWith(ROUTE_BASE + '/api/media/')) {
      const id = pathname.slice((ROUTE_BASE + '/api/media/').length)
      const file = trackFilePath(id)
      if (!file) {
        sendJson(res, 400, { ok: false, error: 'bad track id' })
        return
      }
      streamMedia(req, res, file)
      return
    }

    if (pathname.startsWith(ROUTE_BASE + '/api/tracks/')) {
      const id = pathname.slice((ROUTE_BASE + '/api/tracks/').length)
      if (!TRACK_ID_RE.test(id)) {
        sendJson(res, 400, { ok: false, error: 'bad track id' })
        return
      }
      const lib = readLibrary()
      const index = lib.tracks.findIndex((t) => t.id === id)

      if (method === 'DELETE') {
        if (index >= 0) lib.tracks.splice(index, 1)
        writeLibrary(lib)
        const file = trackFilePath(id)
        if (file) {
          try { fs.unlinkSync(file) } catch {}
        }
        const cfg = readConfig()
        if (cfg.selectedTrackId === id) {
          writeConfig({ ...cfg, selectedTrackId: lib.tracks[0]?.id || '' })
        }
        sendJson(res, 200, { ok: true, tracks: lib.tracks })
        return
      }

      if (method === 'POST' || method === 'PATCH') {
        const payload = await readJson(req)
        if (payload === null) {
          sendJson(res, 400, { ok: false, error: 'invalid json' })
          return
        }
        if (index >= 0) {
          if (typeof payload.title === 'string') {
            lib.tracks[index].title = String(payload.title).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || lib.tracks[index].title
          }
          if (payload.duration !== undefined) {
            lib.tracks[index].duration = clampNumber(payload.duration, 0, 24 * 3600, lib.tracks[index].duration)
          }
          writeLibrary(lib)
        }
        sendJson(res, 200, { ok: true, tracks: lib.tracks })
        return
      }

      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }

  const disposers = []

  disposers.push(webServer.register({
    kind: 'prefix',
    path: ROUTE_BASE,
    handler: (req, res) => {
      Promise.resolve(handle(req, res)).catch((err) => {
        try {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          else res.destroy()
        } catch {}
      })
    }
  }))

  /* 用结构化 index 注入行，而不是 tapIndex：
   * - Web 端：dsh-host-frontend-static 的 renderIndex() 会把 rows 渲染进 index；
   * - 桌面端：dsh-app:// 的静态壳在 boot 时通过 dshDesktopBoot.ready()
   *   拿到 injections 并逐行执行（global / style / script / script-src）。
   * 两条路径都支持同样五种 row，所以一份声明即可两边生效。 */
  const injectionRows = () => ([
    {
      kind: 'global',
      name: '__DSH_AUDIO_PLAYER_CONFIG__',
      value: { base: ROUTE_BASE, version: VERSION, maxUpload: MAX_UPLOAD }
    },
    {
      kind: 'style',
      placement: 'head',
      text: '#dsh-audio-player-host{position:fixed;inset:0;z-index:2147482000;pointer-events:none}'
    },
    {
      kind: 'script',
      placement: 'head',
      text: BRIDGE_JS
    },
    {
      kind: 'script-src',
      placement: 'body',
      src: ROUTE_BASE + '/app.js?v=' + VERSION
    }
  ])

  const offInject = ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    table.push(...injectionRows())
  })
  disposers.push(() => { try { offInject() } catch {} })

  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  })
}

export { apply, VERSION, NS as name }
