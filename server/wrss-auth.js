(() => {
  let session = null
  let status = { login: null, info: null, qr: null, scanned: false }

  function emitStatus(next) {
    status = { ...status, ...next }
    window.dispatchEvent(new CustomEvent("pussycat-wechat-auth-change", { detail: status }))
  }

  function cancel() {
    session?.controller.abort()
    session = null
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  async function request(path, signal) {
    signal.throwIfAborted()
    const token = localStorage.getItem("token")
    const response = await fetch("/api/v1/wx/auth/qr/" + path, {
      signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
    })
    signal.throwIfAborted()
    if (response.status === 401) throw new Error("公众号登录已失效，请重新打开公众号")
    if (!response.ok) throw new Error("二维码服务暂时不可用，请重试")
    const body = await response.json()
    signal.throwIfAborted()
    if (body.code !== 0) throw new Error(body.message || "二维码服务暂时不可用，请重试")
    return body.data
  }

  async function within(current, timeoutMs, message, action) {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      current.controller.abort()
    }, timeoutMs)
    try {
      return await action(current.controller.signal)
    } catch (error) {
      if (timedOut) throw new Error(message)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  function normalizeCode(code) {
    return code ? "/" + String(code).replace(/^\/+/, "") : ""
  }

  async function createQr(current) {
    return within(current, 45_000, "获取二维码超时，请检查网络后重试", async (signal) => {
      const result = await request("code", signal)
      if (!result?.code) throw new Error("未能生成二维码，请重试")
      if (!result.is_exists) {
        while (!(await request("image", signal))) await delay(250, signal)
      }
      const qr = { ...result, code: normalizeCode(result.code) }
      current.expiresAt = Date.now() + 45_000
      emitStatus({ qr, scanned: false })
      return qr
    })
  }

  function prefetch() {
    if (session?.qrPromise && (!session.expiresAt || session.expiresAt > Date.now())) return session.qrPromise
    if (session) cancel()
    const current = { controller: new AbortController(), qrPromise: null }
    session = current
    current.qrPromise = createQr(current).catch((error) => {
      if (session === current) session = null
      throw error
    })
    return current.qrPromise
  }

  async function qrCode() {
    return prefetch()
  }

  async function checkStatus(onUpdate) {
    const current = session
    if (!current) throw new DOMException("授权已取消", "AbortError")
    try {
      return await within(current, 5 * 60_000, "二维码已过期，请重新获取并扫码", async (signal) => {
        while (true) {
          const result = await request("status", signal)
          const next = { ...result, code: normalizeCode(result?.code) }
          if (typeof onUpdate === "function") {
            onUpdate(next)
          }
          emitStatus({ scanned: !!next.scanned, qr: next.code ? { code: next.code, version: next.version, expires_at: next.expires_at } : status.qr })
          if (result?.login_status) {
            emitStatus({ login: true, info: result.info || status.info, scanned: false })
            return result
          }
          if (result?.qr_code === false) throw new Error("二维码已失效，请重新获取")
          await delay(1_000, signal)
        }
      })
    } finally {
      if (session === current) session = null
    }
  }

  async function logout() {
    cancel()
    const token = localStorage.getItem("token")
    const response = await fetch("/api/v1/wx/auth/wechat/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: token ? { Authorization: "Bearer " + token } : {},
    })
    const body = await response.json()
    if (!response.ok || body.code !== 0) throw new Error(body.message || "退出公众号登录失败")
    emitStatus({ login: false, info: null, qr: null, scanned: false })
    await status.refresh?.()
    return body.data
  }

  function bindStatus(next) {
    emitStatus(next || {})
  }

  function getState() {
    return status
  }

  window.__PUSSYCAT_WRSS_AUTH__ = {
    qrCode,
    prefetch,
    checkStatus,
    cancel,
    logout,
    bindStatus,
    getState,
  }
})()
