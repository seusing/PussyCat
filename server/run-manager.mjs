import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export class RunManagerError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'RunManagerError'
    this.statusCode = statusCode
  }
}

function createLineCollector(onLine) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let flushed = false

  const drain = (flush) => {
    const parts = pending.split(/\r?\n/)
    pending = parts.pop() ?? ''
    for (const line of parts) onLine(line)
    if (flush && pending) {
      onLine(pending)
      pending = ''
    }
  }

  return {
    push(chunk) {
      if (flushed) return
      pending += decoder.write(chunk)
      drain(false)
    },
    flush() {
      if (flushed) return
      flushed = true
      pending += decoder.end()
      drain(true)
    },
  }
}

function normalizeJsonResult(text) {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  if (Array.isArray(parsed)) {
    return parsed.map((value) => (
      value && typeof value === 'object' && !Array.isArray(value) ? value : { value }
    ))
  }
  return [parsed && typeof parsed === 'object' ? parsed : { value: parsed }]
}

function errorDetail(stderr) {
  const detail = stderr.trim()
  return detail ? detail.slice(-8000) : undefined
}

export class RunManager {
  constructor({
    opencliEntry,
    emitEvent,
    nodePath = process.execPath,
    spawnImpl = spawn,
    cancelGraceMs = 2000,
    commandTimeoutMs = 90_000,
    maxConcurrentRuns = 1,
    maxCapturedBytes = 8 * 1024 * 1024,
    maxSeenRunIds = 1000,
  }) {
    if (!opencliEntry) throw new Error('opencliEntry is required')
    if (typeof emitEvent !== 'function') throw new Error('emitEvent is required')
    this.opencliEntry = opencliEntry
    this.emitEvent = emitEvent
    this.nodePath = nodePath
    this.spawnImpl = spawnImpl
    this.cancelGraceMs = cancelGraceMs
    this.commandTimeoutMs = commandTimeoutMs
    this.maxConcurrentRuns = maxConcurrentRuns
    this.maxCapturedBytes = maxCapturedBytes
    this.maxSeenRunIds = maxSeenRunIds
    this.active = new Map()
    this.seen = new Set()
  }

  start(request) {
    if (this.active.has(request.runId) || this.seen.has(request.runId)) {
      throw new RunManagerError(409, `Duplicate runId: ${request.runId}`)
    }
    if (this.active.size >= this.maxConcurrentRuns) {
      throw new RunManagerError(429, 'Maximum concurrent runs reached')
    }
    this.seen.add(request.runId)
    // 有界最近集:插入序驱逐最旧(Set 迭代序=插入序);在途 run 由 active.has 兜底,驱逐不影响其去重
    if (this.seen.size > this.maxSeenRunIds) {
      this.seen.delete(this.seen.values().next().value)
    }

    const record = {
      request,
      child: undefined,
      seq: 0,
      stdout: '',
      stderr: '',
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      captureFlushed: false,
      capturedBytes: 0,
      finished: false,
      cancelRequested: false,
      timedOut: false,
      outputLimitExceeded: false,
      forceTimer: undefined,
      timeoutTimer: undefined,
    }
    this.active.set(request.runId, record)

    let child
    try {
      child = this.spawnImpl(
        this.nodePath,
        [this.opencliEntry, ...request.argv],
        { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      record.child = child
    } catch (error) {
      this.#finish(record, {
        runId: request.runId,
        at: Date.now(),
        outcome: 'error',
        error: {
          summary: 'Failed to start OpenCLI',
          detail: error instanceof Error ? error.message : String(error),
        },
      })
      return { runId: request.runId }
    }

    const stdoutLines = createLineCollector((text) => this.#output(record, 'stdout', text))
    const stderrLines = createLineCollector((text) => this.#output(record, 'stderr', text))
    child.stdout?.on('data', (chunk) => {
      if (this.#capture(record, 'stdout', chunk)) stdoutLines.push(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      if (this.#capture(record, 'stderr', chunk)) stderrLines.push(chunk)
    })

    child.once('error', (error) => {
      stdoutLines.flush()
      stderrLines.flush()
      this.#flushCapture(record)
      this.#finish(record, {
        runId: request.runId,
        at: Date.now(),
        outcome: 'error',
        error: { summary: 'OpenCLI process error', detail: error.message },
      })
    })
    child.once('close', (exitCode, signal) => {
      stdoutLines.flush()
      stderrLines.flush()
      this.#flushCapture(record)
      this.#onClose(record, exitCode, signal)
    })

    record.timeoutTimer = setTimeout(() => {
      if (record.finished) return
      record.timedOut = true
      this.#terminate(record)
    }, this.commandTimeoutMs)
    record.timeoutTimer.unref?.()

    return { runId: request.runId }
  }

  cancel(runId) {
    const record = this.active.get(runId)
    if (!record || record.finished || record.cancelRequested) return
    record.cancelRequested = true
    this.#terminate(record)
  }

  close() {
    for (const record of this.active.values()) {
      record.cancelRequested = true
      this.#terminate(record)
    }
  }

  #capture(record, stream, chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    record.capturedBytes += buffer.length
    if (record.capturedBytes > this.maxCapturedBytes) {
      if (!record.outputLimitExceeded) {
        record.outputLimitExceeded = true
        this.#terminate(record)
      }
      return false
    }
    if (stream === 'stdout') record.stdout += record.stdoutDecoder.write(buffer)
    else record.stderr += record.stderrDecoder.write(buffer)
    return true
  }

  #flushCapture(record) {
    if (record.captureFlushed) return
    record.captureFlushed = true
    record.stdout += record.stdoutDecoder.end()
    record.stderr += record.stderrDecoder.end()
  }

  #output(record, stream, text) {
    if (record.finished) return
    this.emitEvent('output', {
      runId: record.request.runId,
      seq: record.seq,
      at: Date.now(),
      stream,
      text,
    })
    record.seq += 1
  }

  #terminate(record) {
    if (!record.child || record.finished) return
    try {
      record.child.kill('SIGTERM')
    } catch (error) {
      this.#finish(record, {
        runId: record.request.runId,
        at: Date.now(),
        outcome: 'error',
        error: {
          summary: 'Failed to terminate OpenCLI',
          detail: error instanceof Error ? error.message : String(error),
        },
      })
      return
    }
    if (record.forceTimer) return
    record.forceTimer = setTimeout(() => {
      if (record.finished) return
      try {
        record.child.kill('SIGKILL')
      } catch (error) {
        this.#finish(record, {
          runId: record.request.runId,
          at: Date.now(),
          outcome: 'error',
          error: {
            summary: 'Failed to force terminate OpenCLI',
            detail: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }, this.cancelGraceMs)
    record.forceTimer.unref?.()
  }

  #onClose(record, exitCode, signal) {
    if (record.finished) return
    const base = {
      runId: record.request.runId,
      at: Date.now(),
      ...(typeof exitCode === 'number' ? { exitCode } : {}),
    }

    if (record.outputLimitExceeded) {
      this.#finish(record, {
        ...base,
        outcome: 'error',
        error: { summary: 'OpenCLI output exceeded the capture limit' },
      })
      return
    }
    if (record.timedOut) {
      this.#finish(record, {
        ...base,
        outcome: 'error',
        error: { summary: `OpenCLI timed out after ${this.commandTimeoutMs}ms`, detail: errorDetail(record.stderr) },
      })
      return
    }
    if (signal && record.cancelRequested) {
      this.#finish(record, { ...base, outcome: 'cancelled' })
      return
    }
    if (signal) {
      this.#finish(record, {
        ...base,
        outcome: 'error',
        error: { summary: `OpenCLI terminated by ${signal}`, detail: errorDetail(record.stderr) },
      })
      return
    }
    if (exitCode !== 0) {
      this.#finish(record, {
        ...base,
        outcome: 'error',
        error: { summary: `OpenCLI exited with code ${exitCode}`, detail: errorDetail(record.stderr) },
      })
      return
    }

    try {
      this.#finish(record, { ...base, outcome: 'success', result: normalizeJsonResult(record.stdout) })
    } catch (error) {
      this.#finish(record, {
        ...base,
        outcome: 'error',
        error: {
          summary: 'OpenCLI returned invalid JSON',
          detail: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  #finish(record, event) {
    if (record.finished) return
    record.finished = true
    clearTimeout(record.forceTimer)
    clearTimeout(record.timeoutTimer)
    this.active.delete(record.request.runId)
    this.emitEvent('done', event)
  }
}
