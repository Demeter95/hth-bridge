/**
 * HTH — Harness ↔ Telegram bridge (host plugin).
 *
 * Tails a JSONL queue on a remote host over SSH, injects every incoming text
 * as a queued prompt into a live Harness session, and appends the assistant's
 * reply of Telegram-originated turns to an outbound queue file that a small
 * relay bot forwards to Telegram.
 *
 * No inbound ports: the plugin initiates the SSH connection and reads with
 * `tail -f`, persisting the byte offset locally so restarts lose nothing.
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const inject = ['sessionController', 'agents', 'sessions']

const SSH = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
  : 'ssh'

function log(...args) {
  console.log('[hth-bridge]', ...args)
}

export function apply(ctx, rawConfig) {
  const cfg = Object.assign({
    host: '',
    keyPath: '',
    knownHostsPath: '',
    inFile: '/var/lib/hth/in.jsonl',
    outFile: '/var/lib/hth/out.jsonl',
    sessionId: '',
    dryRun: false,
    stateDir: '',
  }, rawConfig || {})

  if (!cfg.host) {
    log('no host configured — bridge disabled')
    return () => {}
  }

  const stateDir = cfg.stateDir || join(homedir(), '.hth-bridge')
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch (e) {
    log('cannot create state dir', e)
  }
  const offsetFile = join(stateDir, 'in.offset')

  function sshArgs() {
    const args = []
    if (cfg.keyPath) args.push('-i', cfg.keyPath)
    args.push(
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
    )
    if (cfg.knownHostsPath) args.push('-o', 'UserKnownHostsFile=' + cfg.knownHostsPath)
    args.push(
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ConnectTimeout=15',
      cfg.host,
    )
    return args
  }

  function shq(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'"
  }

  function readOffset() {
    try {
      const n = parseInt(readFileSync(offsetFile, 'utf8'), 10)
      return Number.isFinite(n) && n >= 0 ? n : -1
    } catch {
      return -1
    }
  }

  function saveOffset(n) {
    try {
      writeFileSync(offsetFile, String(n))
    } catch (e) {
      log('cannot save offset', e)
    }
  }

  function remoteSize() {
    try {
      const out = execFileSync(SSH, [...sshArgs(), `stat -c %s ${shq(cfg.inFile)} 2>/dev/null || echo 0`],
        { encoding: 'utf8', timeout: 20000, windowsHide: true })
      const n = parseInt(out.trim(), 10)
      return Number.isFinite(n) && n >= 0 ? n : 0
    } catch (e) {
      log('cannot stat remote queue', e)
      return null
    }
  }

  // ---------------------------------------------------------------- session id
  let cachedSessionId = ''

  function sessionIdFromPath(p) {
    // Session directories are named after the exact SessionId, which in current
    // builds already carries the `session-` prefix (e.g. `session-0fed2e76-...`).
    const parts = String(p).split(/[\\/]/)
    return parts[parts.length - 2] || ''
  }

  function newestSessionId() {
    const root = join(homedir(), '.dsh', 'sessions')
    let best = null
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          stack.push(p)
        } else if (e.isFile() && /^session\.v\d+\.jsonl/.test(e.name)) {
          try {
            const st = statSync(p)
            if (!best || st.mtimeMs > best.mtime) best = { mtime: st.mtimeMs, id: sessionIdFromPath(p) }
          } catch {
            /* ignore */
          }
        }
      }
    }
    return best ? best.id : ''
  }

  function resolveSessionId() {
    if (cfg.sessionId) return cfg.sessionId
    if (!cachedSessionId) cachedSessionId = newestSessionId()
    return cachedSessionId
  }

  // ---------------------------------------------------------------- outbound
  function appendOut(obj) {
    const line = JSON.stringify(obj) + '\n'
    try {
      const p = spawn(SSH, [...sshArgs(), `cat >> ${shq(cfg.outFile)}`],
        { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      p.on('error', (e) => log('outbound ssh error', e))
      p.stdin.write(line)
      p.stdin.end()
    } catch (e) {
      log('cannot append outbound', e)
    }
  }

  // ---------------------------------------------------------------- inbound
  // Turns started by a bridged message are the only ones mirrored to Telegram.
  const pendingBridge = new Map()
  const bridgeTurn = new Map()

  async function inject(text, id) {
    const sessionId = resolveSessionId()
    if (!sessionId) {
      appendOut({ kind: 'ack', id, ok: false, error: 'session not found' })
      return
    }
    if (cfg.dryRun) {
      log('DRY RUN prompt:', text.slice(0, 120))
      appendOut({ kind: 'ack', id, ok: true, dryRun: true })
      return
    }
    try {
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if (resolved && resolved.error) throw new Error('session: ' + resolved.error.code)
      const signal = new AbortController().signal
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, signal)
      log('prompt injected', sessionId, text.slice(0, 80))
      pendingBridge.set(sessionId, (pendingBridge.get(sessionId) || 0) + 1)
      appendOut({ kind: 'ack', id, ok: true })
    } catch (e) {
      const message = e && e.message ? e.message : String(e)
      log('prompt failed', message)
      appendOut({ kind: 'ack', id, ok: false, error: message })
    }
  }

  function handleLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const text = typeof msg.text === 'string' ? msg.text.trim() : ''
    if (!text) return
    inject(text, msg.id || '')
  }

  // ---------------------------------------------------------------- tail loop
  let tailChild = null
  let stopped = false

  function startTail() {
    if (stopped) return
    let off = readOffset()
    if (off < 0) {
      const size = remoteSize()
      if (size === null) {
        setTimeout(startTail, 5000)
        return
      }
      off = size
      saveOffset(off)
    }
    log('tail from offset', off)
    const child = spawn(SSH, [...sshArgs(), `tail -c +${off + 1} -f ${shq(cfg.inFile)}`],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    tailChild = child
    let buf = Buffer.alloc(0)
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const idx = buf.indexOf(0x0a)
        if (idx < 0) break
        const line = buf.subarray(0, idx).toString('utf8')
        buf = buf.subarray(idx + 1)
        off += idx + 1
        saveOffset(off)
        if (line.trim()) handleLine(line)
      }
    })
    child.stderr.on('data', (d) => {
      const s = d.toString().trim()
      if (s) log('tail stderr:', s.slice(0, 200))
    })
    child.on('error', (e) => log('tail spawn error', e))
    child.on('close', (code) => {
      tailChild = null
      if (!stopped) {
        log('tail closed', code, '- restarting in 3s')
        setTimeout(startTail, 3000)
      }
    })
  }

  ctx.effect(() => {
    log('starting bridge to', cfg.host)
    try {
      appendOut({
        kind: 'diag',
        resolvedSession: resolveSessionId(),
        agents: ctx.agents.list().map((a) => a.id),
        sessions: ctx.sessions.list().map((s) => s.id),
        ts: Date.now(),
      })
    } catch (e) {
      appendOut({ kind: 'diag', error: String(e && e.message ? e.message : e), ts: Date.now() })
    }
    appendOut({ kind: 'bridge', status: 'started', ts: Date.now() })
    startTail()
    return () => {
      stopped = true
      if (tailChild) {
        try {
          tailChild.kill()
        } catch {
          /* ignore */
        }
      }
      tailChild = null
    }
  })

  // ---------------------------------------------------------------- replies
  // Only turns started by a bridged Telegram message are mirrored back.
  const turnBuffers = new Map()

  function assistantText(message) {
    const blocks = message && Array.isArray(message.content) ? message.content : []
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      const sid = session.id
      if (!sid || sid !== resolveSessionId()) return
      if (event.type === 'turn/start') {
        const pending = pendingBridge.get(sid) || 0
        if (pending > 0) pendingBridge.set(sid, pending - 1)
        bridgeTurn.set(sid, pending > 0)
        turnBuffers.delete(sid)
        return
      }
      if (event.type === 'assistant/message') {
        const text = assistantText(event.data && event.data.message)
        if (!text) return
        const buf = turnBuffers.get(sid) || []
        buf.push(text)
        turnBuffers.set(sid, buf)
        return
      }
      if (event.type === 'turn/end') {
        const fromBridge = bridgeTurn.get(sid) === true
        bridgeTurn.delete(sid)
        const parts = turnBuffers.get(sid) || []
        turnBuffers.delete(sid)
        if (!fromBridge) {
          log('turn ended from GUI - not mirrored')
          return
        }
        const text = parts.join('\n\n').trim()
        if (text) appendOut({ kind: 'assistant', text, ts: Date.now() })
      }
    } catch (e) {
      log('session event error', e)
    }
  })
}
