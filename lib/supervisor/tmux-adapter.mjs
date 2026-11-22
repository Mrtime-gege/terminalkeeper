/**
 * supervisor 内的 tmux 子进程适配层。
 *
 * TmuxDriver 依赖 DSH 的 `subprocess` 服务；监督进程不加载 DSH，因此这里提供
 * 最小同形适配：spawn + collected.stdout/stderr + done + timer.timeout。
 * 只覆盖驱动实际使用的形态（stdin: ignore|pipe，stdout/stderr 带 maxBytes）。
 *
 * SUP-04：ControlClient 需要的是**管道形态**的 handle（stdin 可写、stdout 可读、
 * terminate() 能收尾）。旧实现只给 done/collected/kill，导致 control 模式每次
 * acquire 都命中 "missing pipes" 并退回一次性 spawn，架构承诺（复用长驻客户端）
 * 在 supervisor 内根本不成立。现在把这三项如实暴露出来。
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
      // 注意：**不要**在 pipe 模式下擅自 end() —— control 客户端要在同一个 stdin
      // 上持续写命令；只有在 spawn 阶段就失败的场景才由 done/terminate 收尾。
      // 只有**一次性命令**（stdin 不是 pipe）才用 graceMs 兜底；control 客户端要在同一个
      // stdin 上长驻，不能被定时器杀掉（否则 supervisor 模式每条命令都会退回 CLI）。
      const oneShot = options?.stdio?.stdin !== 'pipe'
      let timer = null
      const clearTimer = () => { if (timer !== null) { clearTimeout(timer); timer = null } }
      const done = new Promise((resolve) => {
        const finish = (code, signal) => {
          clearTimer()
          resolve({ exitCode: Number.isFinite(code) ? code : (signal ? 128 : 1), signal: signal ?? null })
        }
        child.once('error', (error) => {
          err.push(Buffer.from(String(error?.message ?? error)))
          finish(127, null)
        })
        child.once('close', finish)
        if (oneShot) {
          const grace = Number(options?.graceMs)
          if (Number.isFinite(grace) && grace > 0) {
            timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 忽略 */ } }, grace)
            if (typeof timer.unref === 'function') timer.unref()
          }
        }
      })
      const kill = (signal = 'SIGTERM') => { try { child.kill(signal) } catch { /* 忽略 */ } }
      // ControlClient 的超时/故障收尾路径（tmux.js control.command）：先 TERM，宽限后 KILL。
      const terminate = () => {
        kill('SIGTERM')
        const hard = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, 500)
        if (typeof hard.unref === 'function') hard.unref()
      }
      // 子进程提前退出时写 stdin 会 EPIPE；不打这个兜底，未捕获的 'error' 会杀掉 daemon。
      if (child.stdin !== null && child.stdin !== undefined) child.stdin.on('error', () => { /* EPIPE：预期 */ })
      return {
        done,
        collected: {
          stdout: { readFrom: () => bufferView(out) },
          stderr: { readFrom: () => bufferView(err) },
        },
        kill,
        terminate,
        // 同形 DSH subprocess handle：管道句柄（非 pipe 模式下为 undefined）。
        stdin: child.stdin ?? undefined,
        stdout: child.stdout ?? undefined,
        stderr: child.stderr ?? undefined,
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