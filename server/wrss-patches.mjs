import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const AUTH_API = 'const QRCode=()=>window.__PUSSYCAT_WRSS_AUTH__.qrCode(),checkQRCodeStatus=onUpdate=>window.__PUSSYCAT_WRSS_AUTH__.checkStatus(onUpdate),'
const AUTH_SETUP = `const c=ref(false),d=ref(false),u=ref(""),A=ref(""),scanned=ref(false),remaining=ref(60);
let generation=0;
const f=()=>{generation++;window.__PUSSYCAT_WRSS_AUTH__.cancel();d.value=false;};
const g=async()=>{
  const current=++generation;
  c.value=true;d.value=true;u.value="";A.value="";scanned.value=false;remaining.value=60;
  try {
    const result=await QRCode();
    if(current!==generation)return;
    u.value=result.code;d.value=false;
    const status=await checkQRCodeStatus(next=>{if(current!==generation)return;if(next.code)u.value=next.code;scanned.value=!!next.scanned;if(next.expires_at)remaining.value=Math.max(0,Math.ceil(next.expires_at-Date.now()/1000));});
    if(current!==generation)return;
    c.value=false;s("success",status);
  } catch(error) {
    if(current!==generation)return;
    d.value=false;u.value="";A.value=error.message||"授权失败，请重试";s("error",error);
  }
};
onBeforeUnmount(f);
`
const QR_PAGE = `            page = driver.page
            self._qr_scanned = False
            self._qr_login_complete = False
            self._qr_cancelled = False
            self._qr_version = getattr(self, "_qr_version", 0)
            qr_tag = ".login__type__container__scan__qrcode"

            async def scan_status(response):
                if "/cgi-bin/scanloginqrcode" not in response.url or "action=ask" not in response.url:
                    return
                try:
                    result = await response.json()
                    if int(result.get("status", 0)) in (1, 2, 3, 4):
                        self._qr_scanned = True
                except Exception:
                    pass

            async def load_qr():
                import base64
                await page.goto(self.WX_LOGIN, wait_until="domcontentloaded", timeout=20000)
                await page.wait_for_function(
                    "selector => { const img = document.querySelector(selector); return img && img.complete && img.naturalWidth > 0; }",
                    arg=qr_tag,
                    timeout=15000,
                )
                image = await page.locator(qr_tag).evaluate("img => { const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; canvas.getContext('2d').drawImage(img, 0, 0); return canvas.toDataURL('image/png').split(',')[1]; }")
                with open(self.wx_login_url, "wb") as output:
                    output.write(base64.b64decode(image))
                self._qr_version += 1
                self._qr_expires_at = time.time() + 60
                self.HasCode = True

            page.on("response", scan_status)
            await load_qr()
            if self.Notice is not None:
                self.Notice()
            deadline = time.monotonic() + 5 * 60
            from urllib.parse import urlparse, parse_qs
            while time.monotonic() < deadline and not self._qr_cancelled:
                current_url = page.url
                if self.WX_HOME in current_url and parse_qs(urlparse(current_url).query).get("token"):
                    self.CallBack = CallBack
                    await self.Call_Success()
                    from .success import getStatus
                    self._qr_login_complete = bool(self.SESSION and self.SESSION.get("token") and getStatus())
                    break
                if not self._qr_scanned and time.time() >= self._qr_expires_at:
                    await load_qr()
                await asyncio.sleep(0.2)
            else:
                if not self._qr_cancelled:
                    raise TimeoutError("扫码登录超时")
`
const QR_STATUS = `    def QrStatus(self):
        return {
            "login_status": getattr(self, "_qr_login_complete", False),
            "qr_code": self.GetHasCode(),
            "scanned": getattr(self, "_qr_scanned", False),
            "version": getattr(self, "_qr_version", 0),
            "expires_at": getattr(self, "_qr_expires_at", 0),
            "code": f"/{self.wx_login_url}?v={getattr(self, '_qr_version', 0)}",
        }
`
const WECHAT_LOGOUT = `
@router.post("/wechat/logout", summary="退出微信授权")
async def logout_wechat(current_user: dict = Depends(get_current_user)):
    from driver.token import _save_to_local, REDIS_TOKEN_PREFIX
    from core.redis_client import redis_client
    from driver.success import setStatus
    from driver.wx import Store
    WX_API._qr_cancelled = True
    WX_API._qr_login_complete = False
    WX_API._qr_scanned = False
    WX_API.SESSION = None
    with WX_API._login_lock:
        WX_API._haslogin = False
    _save_to_local({})
    if redis_client.is_connected:
        redis_client._client.delete(REDIS_TOKEN_PREFIX + "data")
    Store.save([])
    setStatus(False)
    return success_response({"login": False})
`

const LOGIN_STATUS = `def getStatus():
    """从本进程状态和持久化凭据获取登录状态。"""
    global WX_LOGIN_ED
    import time

    with login_lock:
        if WX_LOGIN_ED is False:
            return False

    token_data = getLoginInfo()
    expiry = token_data.get('expiry') if token_data else None
    expiry_timestamp = expiry.get('expiry_timestamp') if expiry else None
    valid = bool(
        token_data
        and token_data.get('token')
        and token_data.get('cookie')
        and expiry_timestamp
        and expiry_timestamp >= time.time()
    )

    with login_lock:
        WX_LOGIN_ED = valid
        return WX_LOGIN_ED
`
const CAN_GET_TOKEN = `def CanGetToken():
    """检查当前持久化凭据是否仍然有效。"""
    if not getStatus():
        print_warning("当前未登录，请先扫码登录")
        return False
    return True
`

function replaceOnce(source, before, after) {
  if (source.includes(after)) return source
  const at = source.indexOf(before)
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) throw new Error('WeRSS v1.5.2 页面代码不符合预期')
  return source.slice(0, at) + after + source.slice(at + before.length)
}

function patchBundle(source) {
  if (!source.includes(AUTH_API)) {
    const start = source.indexOf('let qrCodeIntervalId=') >= 0 ? source.indexOf('let qrCodeIntervalId=') : source.indexOf('const QRCode=')
    const end = source.indexOf('refreshToken=()=>http$1.post("/wx/auth/refresh")', start)
    if (start < 0 || end < 0) throw new Error('WeRSS v1.5.2 二维码接口代码不符合预期')
    source = source.slice(0, start) + AUTH_API + source.slice(end)
  }
  if (!source.includes(AUTH_SETUP)) {
    const component = '__name:"WechatAuthQrcode",emits:["success","error"],setup(a,{expose:o,emit:s}){'
    const start = source.indexOf(component)
    const end = source.indexOf('return o({startAuth:g})', start)
    if (start < 0 || end < 0) {
      throw new Error('WeRSS v1.5.2 授权窗口代码不符合预期')
    }
    source = source.slice(0, start + component.length) + AUTH_SETUP + source.slice(end)
  }
  source = source.replace('pageSizeOptions:[10,20,50,100]', 'pageSizeOptions:[10,20,30,50]')
  source = source.replace('pageSizeOptions:[10]}', 'pageSizeOptions:[10,20,30,50]}')
  source = replaceOnce(source,
    'createBaseVNode("img",{src:u.value,alt:"\\u5FAE\\u4FE1\\u6388\\u6743\\u4E8C\\u7EF4\\u7801"},null,8,_hoisted_4$1)',
    'createBaseVNode("div",{class:"pussycat-qr-image",style:{position:"relative",width:"240px",margin:"0 auto"}},[createBaseVNode("img",{src:u.value,alt:"微信授权二维码",style:{width:"240px",height:"240px",imageRendering:"pixelated"}},null,8,["src"]),scanned.value?createBaseVNode("div",{class:"pussycat-qr-scanned",style:{position:"absolute",inset:"0",display:"grid",placeContent:"center",background:"rgba(255,255,255,.96)",color:"#222",fontSize:"18px",padding:"20px"}},"已扫码，请在手机上点击确认"):createCommentVNode("",!0)]),createBaseVNode("p",{class:"pussycat-qr-countdown"},scanned.value?"等待手机确认":remaining.value+" 秒后自动刷新",1)',
  )
  return replaceOnce(source, 'const c=ref(l<3),d=N=>', 'const c=ref(!1),d=N=>')
}

function patchDriver(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  let patched = source.replace(/\r\n/g, '\n')
  if (!patched.includes(QR_PAGE)) {
    const loginStart = patched.indexOf('    async def wxLogin(')
    const browserStart = patched.indexOf('            await driver.start_browser()', loginStart)
    if (loginStart < 0 || browserStart < 0) throw new Error('WeRSS v1.5.2 二维码生成代码不符合预期')
    const start = browserStart + '            await driver.start_browser()\n'.length
    const end = patched.indexOf('\n        except Exception as e:', start)
    if (start < 0 || end < 0) throw new Error('WeRSS v1.5.2 二维码生成代码不符合预期')
    patched = patched.slice(0, start) + QR_PAGE + patched.slice(end + 1)
  }
  if (!patched.includes(QR_STATUS)) {
    const start = patched.indexOf('    def QrStatus(self):')
    if (start >= 0) {
      const end = patched.indexOf('    def HasLogin(self):', start)
      patched = patched.slice(0, start) + QR_STATUS + '\n' + patched.slice(end)
    } else {
      const start = patched.indexOf('    async def wxLogin(')
      patched = patched.slice(0, start) + QR_STATUS + '\n' + patched.slice(start)
    }
  }
  return patched.replace(/\n/g, newline)
}

function patchLoginStatus(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  let patched = source.replace(/\r\n/g, '\n')
  patched = replaceOnce(patched, 'WX_LOGIN_ED = False', 'WX_LOGIN_ED = None')
  if (!patched.includes(LOGIN_STATUS)) {
    const start = patched.indexOf('def getStatus():')
    const end = patched.indexOf('def getLoginInfo():', start)
    if (start < 0 || end < 0) throw new Error('WeRSS v1.5.2 登录状态代码不符合预期')
    patched = patched.slice(0, start) + LOGIN_STATUS + patched.slice(end)
  }
  if (!patched.includes(CAN_GET_TOKEN)) {
    const start = patched.indexOf('def CanGetToken():')
    if (start < 0) throw new Error('WeRSS v1.5.2 Token 状态代码不符合预期')
    patched = patched.slice(0, start) + CAN_GET_TOKEN
  }
  return patched.replace(/\n/g, newline)
}

function patchSharedWechatStatus(source) {
  source = replaceOnce(
    source,
    'g=()=>{_.value=!0,Message.success("\\u5FAE\\u4FE1\\u6388\\u6743\\u6210\\u529F")}',
    'g=async()=>{await P(),Message.success("\\u5FAE\\u4FE1\\u6388\\u6743\\u6210\\u529F")}',
  )
  source = replaceOnce(source, 'const w=ref({username:"",avatar:""}),_=ref(!0),', 'const w=ref({username:"",avatar:""}),_=ref(!1),')
  if (!source.includes('provide("pussycatWechatAuth"')) source = source.replace(';return onMounted(()=>{E.value&&B()', ';provide("pussycatWechatAuth",{login:_,info:y,refresh:P});return onMounted(()=>{E.value&&B()')
  source = replaceOnce(source,
    'provide("pussycatWechatAuth",{login:_,info:y,refresh:P});',
    'provide("pussycatWechatAuth",{login:_,info:y,refresh:P});const syncWechatAuth=event=>{_.value=!!event.detail.login;y.value=event.detail.info;};window.addEventListener("pussycat-wechat-auth-change",syncWechatAuth);onBeforeUnmount(()=>window.removeEventListener("pussycat-wechat-auth-change",syncWechatAuth));',
  )
  return replaceOnce(source,
    'y.value=((x=R==null?void 0:R.wx)==null?void 0:x.info)||null',
    'y.value=((x=R==null?void 0:R.wx)==null?void 0:x.info)||null;window.__PUSSYCAT_WRSS_AUTH__.bindStatus({login:_.value,info:y.value,refresh:P})',
  )
}

function patchWechatStatus(source) {
  const before = 'setup(pe){const m=h(!1),o=h(null),F=h(!1),k=H("showAuthQrcode",()=>{r.warning("\\u8BF7\\u4ECE\\u9875\\u9762\\u5934\\u90E8\\u8FDB\\u884C\\u626B\\u7801\\u6388\\u6743")}),y=async()=>{var i,u;try{const c=await K();m.value=((i=c==null?void 0:c.wx)==null?void 0:i.login)||!1,o.value=((u=c==null?void 0:c.wx)==null?void 0:u.info)||null}catch(c){console.error("\\u83B7\\u53D6\\u7CFB\\u7EDF\\u4FE1\\u606F\\u5931\\u8D25",c)}}'
  const after = 'setup(pe){const {login:m,info:o,refresh:y}=H("pussycatWechatAuth"),F=h(!1),k=H("showAuthQrcode",()=>{r.warning("\\u8BF7\\u4ECE\\u9875\\u9762\\u5934\\u90E8\\u8FDB\\u884C\\u626B\\u7801\\u6388\\u6743")})'
  return replaceOnce(source, before, after)
}

function patchMpsApi(source) {
  const oldCatch = `    except Exception as e:\n        print(f"搜索公众号错误: {str(e)}")\n        raise HTTPException(\n            status_code=status.HTTP_201_CREATED,\n            detail=error_response(\n                code=50001,\n                message=f"搜索公众号失败,请重新扫码授权！",\n            )\n        )`
  const newCatch = `    except HTTPException:\n        raise\n    except Exception as e:\n        print(f"搜索公众号错误: {str(e)}")\n        raise HTTPException(\n            status_code=status.HTTP_502_BAD_GATEWAY,\n            detail=error_response(\n                code=50002,\n                message="搜索公众号失败，请稍后重试",\n            )\n        )`
  const rewriteCatch = (value) => value.includes(oldCatch) ? value.replace(oldCatch, newCatch) : value
  if (source.includes('# pussycat_authorization_guard')) return rewriteCatch(source)
  const match = source.match(/^(\s*)(async\s+def|def)\s+(search_mp)\s*\(([^)]*)\)\s*:/m)
  if (!match) return source
  const indent = match[1]
  const bodyIndent = `${indent}    `
  const guard = `${bodyIndent}# pussycat_authorization_guard\n${bodyIndent}from driver.success import getStatus\n${bodyIndent}if not getStatus():\n${bodyIndent}    raise HTTPException(\n${bodyIndent}        status_code=status.HTTP_401_UNAUTHORIZED,\n${bodyIndent}        detail=error_response(code=40101, message="微信公众号授权已失效，请重新扫码授权"),\n${bodyIndent}    )\n`
  const start = match.index + match[0].length
  const patched = source.slice(0, start) + `\n${guard}` + source.slice(start)
  return rewriteCatch(patched)
}

export function ensureWrssSourcePatches(sourceDir) {
  const bundlePath = join(sourceDir, 'static', 'assets', 'index.a75a6e55.js')
  const driverPath = join(sourceDir, 'driver', 'wx.py')
  const loginStatusPath = join(sourceDir, 'driver', 'success.py')
  const wechatStatusPath = join(sourceDir, 'static', 'assets', 'WechatStatus.62cf3d3b.js')
  const authApiPath = join(sourceDir, 'apis', 'auth.py')
  const mpsApiPath = join(sourceDir, 'apis', 'mps.py')
  const bundle = readFileSync(bundlePath, 'utf8')
  const driver = readFileSync(driverPath, 'utf8')
  const loginStatus = readFileSync(loginStatusPath, 'utf8')
  const wechatStatus = readFileSync(wechatStatusPath, 'utf8')
  const patchedBundle = patchSharedWechatStatus(patchBundle(bundle))
  const patchedDriver = patchDriver(driver)
  const patchedLoginStatus = patchLoginStatus(loginStatus)
  const patchedWechatStatus = patchWechatStatus(wechatStatus)
  const mps = existsSync(mpsApiPath) ? readFileSync(mpsApiPath, 'utf8') : null
  const patchedMps = mps === null ? null : patchMpsApi(mps)
  if (bundle !== patchedBundle) writeFileSync(bundlePath, patchedBundle, 'utf8')
  if (driver !== patchedDriver) writeFileSync(driverPath, patchedDriver, 'utf8')
  if (loginStatus !== patchedLoginStatus) writeFileSync(loginStatusPath, patchedLoginStatus, 'utf8')
  if (wechatStatus !== patchedWechatStatus) writeFileSync(wechatStatusPath, patchedWechatStatus, 'utf8')
  if (mps !== null && mps !== patchedMps) writeFileSync(mpsApiPath, patchedMps, 'utf8')
  if (existsSync(authApiPath)) {
    const authApi = readFileSync(authApiPath, 'utf8')
    if (!authApi.includes('async def logout_wechat(')) writeFileSync(authApiPath, `${authApi}\n${WECHAT_LOGOUT}`, 'utf8')
  }
  writeFileSync(join(sourceDir, 'static', 'pussycat-auth.js'), readFileSync(new URL('./wrss-auth.js', import.meta.url)))
}
