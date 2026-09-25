(() => {
  let session = null
  let status = { login: null, info: null, qr: null, scanned: false }

  function emitStatus(next) {
    status = { ...status, ...next }
    window.dispatchEvent(new CustomEvent("pussycat-wechat-auth-change", { detail: status }))
  }

  function authHeaders() {
    const token = localStorage.getItem("token")
    return token ? { Authorization: "Bearer " + token } : {}
  }

  function cancel() {
    session?.controller.abort()
    session = null
    fetch("/api/v1/wx/auth/qr/over", { method: "POST", credentials: "same-origin", keepalive: true, headers: authHeaders() }).catch(() => {})
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve() }, ms)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  async function request(path, signal, method = "GET") {
    signal?.throwIfAborted()
    const response = await fetch("/api/v1/wx/auth/qr/" + path, {
      method, signal, credentials: "same-origin", cache: "no-store", headers: authHeaders(),
    })
    signal?.throwIfAborted()
    const body = await response.json()
    signal?.throwIfAborted()
    const errorCode = body?.code === 40101 ? 40101 : body?.detail?.code
    if (errorCode === 40101) {
      emitStatus({ login: false, info: null })
      throw new Error(body?.message || body?.detail?.message || "公众号登录已失效，请重新扫码授权")
    }
    if (response.status === 401) throw new Error("公众号登录已失效，请重新打开公众号")
    if (!response.ok) throw new Error(body?.message || body?.detail?.message || "二维码服务暂时不可用，请重试")
    if (body.code !== 0) throw new Error(body.message || "二维码服务暂时不可用，请重试")
    return body.data
  }

  async function within(current, timeoutMs, message, action) {
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; current.controller.abort() }, timeoutMs)
    try { return await action(current.controller.signal) }
    catch (error) { if (timedOut) throw new Error(message); throw error }
    finally { clearTimeout(timer) }
  }

  function normalizeCode(code) { return code ? "/" + String(code).replace(/^\/+/, "") : "" }

  function normalizeQr(result) {
    const qr = { ...result, code: normalizeCode(result?.code) }
    if (qr.expires_at) qr.expires_at = Number(qr.expires_at)
    return qr
  }

  async function awaitReady(initial, signal) {
    let result = initial
    while (!result?.is_exists) {
      const imageReady = await request("image", signal)
      if (!imageReady) {
        await delay(250, signal)
        continue
      }
      const next = await request("status", signal)
      if (next?.qr_code && next.version > 0) result = { ...result, ...next, is_exists: true }
      else await delay(250, signal)
    }
    return normalizeQr(result)
  }

  async function createQr(current) {
    return within(current, 45_000, "获取二维码超时，请检查网络后重试", async (signal) => {
      const qr = await awaitReady(await request("code", signal), signal)
      current.version = qr.version || 0
      current.expiresAt = qr.expires_at ? qr.expires_at * 1000 : 0
      emitStatus({ qr, scanned: false })
      return qr
    })
  }

  function newSession() {
    const current = { controller: new AbortController(), qrPromise: null, version: 0, expiresAt: 0 }
    session = current
    return current
  }

  function prefetch() {
    if (session?.qrPromise && session.version > 0 && session.expiresAt > Date.now()) return session.qrPromise
    if (session) cancel()
    const current = newSession()
    current.qrPromise = createQr(current).catch((error) => { if (session === current) session = null; throw error })
    return current.qrPromise
  }

  function qrCode() { return prefetch() }

  async function refreshQr() {
    let current = session
    if (!current || current.controller.signal.aborted) current = newSession()
    const oldVersion = current.version
    let result = await within(current, 45_000, "刷新二维码超时，请检查网络后重试", async (signal) => {
      let next = await awaitReady(await request("refresh", signal, "POST"), signal)
      while ((next.version || 0) <= oldVersion) {
        await delay(250, signal)
        next = normalizeQr(await request("status", signal))
      }
      return next
    })
    current.version = result.version || 0
    current.expiresAt = result.expires_at ? result.expires_at * 1000 : 0
    current.qrPromise = Promise.resolve(result)
    emitStatus({ qr: result, scanned: false })
    return result
  }

  async function checkStatus(onUpdate) {
    const current = session
    if (!current) throw new DOMException("授权已取消", "AbortError")
    try {
      return await within(current, 5 * 60_000, "二维码已过期，请重新获取并扫码", async (signal) => {
        while (true) {
          const result = await request("status", signal)
          const next = { ...result, code: normalizeCode(result?.code) }
          if (typeof onUpdate === "function") onUpdate(next)
          if (next.version > current.version) {
            current.version = next.version
            current.expiresAt = next.expires_at ? next.expires_at * 1000 : 0
          }
          emitStatus({ scanned: !!next.scanned, qr: next.code ? normalizeQr(next) : status.qr })
          if (result?.login_status) {
            emitStatus({ login: true, info: result.info || status.info, scanned: false })
            return result
          }
          if (result?.qr_code === false) throw new Error("二维码已失效，请重新获取")
          await delay(1_000, signal)
        }
      })
    } finally { if (session === current) session = null }
  }

  async function logout() {
    cancel()
    const response = await fetch("/api/v1/wx/auth/wechat/logout", { method: "POST", credentials: "same-origin", headers: authHeaders() })
    const body = await response.json()
    if (!response.ok || body.code !== 0) throw new Error(body.message || "退出公众号登录失败")
    emitStatus({ login: false, info: null, qr: null, scanned: false })
    await status.refresh?.()
    return body.data
  }

  function bindStatus(next) { emitStatus(next || {}) }
  function getState() { return status }

  window.__PUSSYCAT_WRSS_AUTH__ = { qrCode, refreshQr, prefetch, checkStatus, cancel, logout, bindStatus, getState }
})()
