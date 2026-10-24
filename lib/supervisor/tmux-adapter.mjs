/**
 * supervisor 内的 tmux 子进程适配层。
 *
 * TmuxDriver 依赖 DSH 的 `subprocess` 服务；监督进程不加载 DSH，因此这里提供
 * 最小同形适配：spawn + collected.stdout/stderr + done + timer.timeout。
 * 只覆盖驱动实际使用的形态（stdin: ignore|pipe，stdout/stderr 带 maxBytes）。
 */

import { spawn } from 'node:child_process'

function bufferView (chunks) {
  const text = Buffer.concat(chunks).toString('utf8')
  return { text, bytes: Buffer.byteLength(text) }
}

export function createSubprocess () {
  return {
    spawn (options) {
      const argv = Array.isArray(options?.argv) ? options.argv : []
      if (argv.length === 0) throw new Error('subprocess.spawn: argv is empty')
      const stdinMode = options?.stdio?.stdin === 'pipe' ? 'pipe' : 'ignore'
      const child = spawn(argv[0], argv.slice(1), {
        cwd: options?.cwd,
        stdio: [stdinMode, 'pipe', 'pipe'],
        env: options?.env ?? process.env,
      })
      const out = []
      const err = []
      let stdoutBytes = 0
      let stderrBytes = 0
      const outMax = Number(options?.stdio?.stdout?.maxBytes ?? 4 * 1024 * 1024)
      const errMax = Number(options?.stdio?.stderr?.maxBytes ?? 1024 * 1024)
      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length
        if (stdoutBytes <= outMax) out.push(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length
        if (stderrBytes <= errMax) err.push(chunk)
      })
      if (stdinMode === 'pipe') child.stdin.end()
      let timer = null
      const done = new Promise((resolve) => {
        const finish = (code, signal) => {
          if (timer !== null) clearTimeout(timer)
          resolve({ exitCode: Number.isFinite(code) ? code : (signal ? 128 : 1), signal: signal ?? null })
        }
        child.once('error', (error) => {
          err.push(Buffer.from(String(error?.message ?? error)))
          finish(127, null)
        })
        child.once('close', finish)
        const grace = Number(options?.graceMs)
        if (Number.isFinite(grace) && grace > 0) {
          timer = setTimeout(() => {
            try { child.kill('SIGKILL') } catch { /* 忽略 */ }
          }, grace)
          if (typeof timer.unref === 'function') timer.unref()
        }
      })
      return {
        done,
        collected: {
          stdout: { readFrom: () => bufferView(out) },
          stderr: { readFrom: () => bufferView(err) },
        },
        kill: (signal = 'SIGTERM') => { try { child.kill(signal) } catch { /* 忽略 */ } },
      }
    },
  }
}

export function createTimer () {
  return {
    timeout (ms) {
      return new Promise((resolve) => {
        const t = setTimeout(resolve, Math.max(0, Number(ms) || 0))
        if (typeof t.unref === 'function') t.unref()
      })
    },
  }
}