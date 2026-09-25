import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWrssContentBridge } from './wrss-content-bridge.js'

const AUTH_API = 'const QRCode=()=>window.__PUSSYCAT_WRSS_AUTH__.qrCode(),refreshQRCode=()=>window.__PUSSYCAT_WRSS_AUTH__.refreshQr(),checkQRCodeStatus=onUpdate=>window.__PUSSYCAT_WRSS_AUTH__.checkStatus(onUpdate),'
const CONTENT_BRIDGE_FACTORY_START = '/* pussycat-content-bridge-factory:start */'
const CONTENT_BRIDGE_FACTORY_END = '/* pussycat-content-bridge-factory:end */'
const AUTH_SETUP = `const c=ref(false),d=ref(false),u=ref(""),A=ref(""),scanned=ref(false),remaining=ref(60);
let generation=0,countdownTimer=null,expiresAt=0;
const stopCountdown=()=>{if(countdownTimer!==null){clearInterval(countdownTimer);countdownTimer=null;}};
const startCountdown=value=>{const parsed=Number(value||0);expiresAt=parsed>0?parsed:Math.floor(Date.now()/1000)+60;stopCountdown();const tick=()=>{remaining.value=Math.max(0,Math.ceil(expiresAt-Date.now()/1000));};tick();countdownTimer=setInterval(tick,1000);};
const f=()=>{generation++;stopCountdown();window.__PUSSYCAT_WRSS_AUTH__.cancel();d.value=false;};
const refreshQr=async()=>{if(d.value||scanned.value)return;d.value=true;A.value="";try{const result=await refreshQRCode();u.value=result.code;scanned.value=false;startCountdown(result.expires_at);}catch(error){A.value=error.message||"刷新二维码失败，请重试";}finally{d.value=false;}};
const g=async()=>{
  const current=++generation;
  c.value=true;d.value=true;u.value="";A.value="";scanned.value=false;remaining.value=0;stopCountdown();
  try {
    const result=await QRCode();
    if(current!==generation)return;
    u.value=result.code;d.value=false;startCountdown(result.expires_at);
    const status=await checkQRCodeStatus(next=>{if(current!==generation)return;if(next.code)u.value=next.code;scanned.value=!!next.scanned;if(next.expires_at&&Number(next.expires_at)!==expiresAt)startCountdown(next.expires_at);if(next.scanned)stopCountdown();});
    if(current!==generation)return;
    stopCountdown();c.value=false;s("success",status);
  } catch(error) {
    if(current!==generation)return;
    stopCountdown();d.value=false;u.value="";A.value=error.message||"授权失败，请重试";s("error",error);
  }
};
onBeforeUnmount(f);
`
const QR_PAGE = `            page = driver.page
            self._qr_scanned = False
            self._qr_login_complete = False
            self._qr_cancelled = False
            self._qr_refresh_requested = False
            self._qr_expires_at = 0
            self._qr_marker = ""
            self.HasCode = False
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
                result = await page.locator(qr_tag).evaluate("img => { const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; canvas.getContext('2d').drawImage(img, 0, 0); return { image: canvas.toDataURL('image/png').split(',')[1], marker: [img.currentSrc || img.src || '', img.dataset.ticket || '', img.dataset.session || ''].join('|') }; }")
                if isinstance(result, str):
                    result = {"image": result, "marker": str(time.time())}
                with open(self.wx_login_url, "wb") as output:
                    output.write(base64.b64decode(result["image"]))
                self._qr_marker = result["marker"]
                self._qr_version += 1
                self._qr_expires_at = time.time() + 60
                self.HasCode = True
                self._qr_refresh_requested = False

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
                if not self._qr_scanned and self._qr_refresh_requested:
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
const QR_HAS_CODE = `    def GetHasCode(self):
        return bool(
            self.check_lock()
            and self.HasCode
            and getattr(self, "_qr_version", 0) > 0
            and not getattr(self, "_qr_cancelled", False)
        )
`

const QR_GET_CODE = `    def GetCode(self, CallBack=None, Notice=None):
        self.Notice = Notice
        thread = getattr(self, "thread", None)
        if thread is not None and thread.is_alive():
            return self.QRcode()

        self.HasCode = False
        self._qr_scanned = False
        self._qr_login_complete = False
        self._qr_cancelled = False
        self._qr_refresh_requested = False
        self._qr_expires_at = 0
        self.Clean()

        def run_wxLogin():
            import asyncio
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(self.wxLogin(CallBack, True))
            finally:
                loop.close()

        from core.thread import ThreadManager
        self.thread = ThreadManager(target=run_wxLogin)
        self.thread.start()
        from core.ver import VERSION
        print(f"微信公众平台登录 v{VERSION}")
        return self.QRcode()

    def RequestQrRefresh(self, CallBack=None):
        thread = getattr(self, "thread", None)
        if thread is None or not thread.is_alive():
            return self.GetCode(CallBack)
        if getattr(self, "_qr_scanned", False):
            return {"ok": False, "message": "二维码已扫码，正在等待手机确认"}
        self._qr_refresh_requested = True
        return {"ok": True, **self.QrStatus()}

    def CancelQr(self):
        self._qr_cancelled = True
        self._qr_refresh_requested = False
        self.HasCode = False
        return True
`

const QR_CHECK_LOCK = `    def check_lock(self, timeout: int = 300) -> bool:
        return bool(self.isLOCK)
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
const QR_AUTH_ROUTES = `@router.get("/qr/code", summary="获取登录二维码")
async def get_qrcode(current_user=Depends(get_current_user)):
    return success_response(WX_API.GetCode(Success))

@router.get("/qr/image", summary="获取登录二维码图片")
async def qr_image(current_user=Depends(get_current_user)):
    return success_response(WX_API.GetHasCode())

@router.get("/qr/status", summary="获取扫描状态")
async def qr_status(current_user=Depends(get_current_user)):
    return success_response(WX_API.QrStatus())

@router.post("/qr/refresh", summary="刷新登录二维码")
async def refresh_qrcode(current_user=Depends(get_current_user)):
    result = WX_API.RequestQrRefresh(Success)
    if result.get("ok") is False:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=result["message"])
    return success_response(result)

@router.post("/qr/over", summary="取消扫码")
async def qr_success(current_user=Depends(get_current_user)):
    WX_API.CancelQr()
    return success_response(True)
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
    remaining_seconds = expiry.get('remaining_seconds') if expiry else None
    expiry_valid = (
        (expiry_timestamp is not None and expiry_timestamp >= time.time())
        or (remaining_seconds is not None and remaining_seconds > 0)
    )
    valid = bool(
        token_data
        and token_data.get('token')
        and token_data.get('cookie')
        and expiry_valid
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
  if (!source.includes('pussycat-content-bridge-v1')) {
    const component = '__name:"ArticleListDesktop",setup(a){const o=ref([]),s=ref(!1),l=ref([]),c=ref(!1),d=ref("")'
    if (!source.includes(component)) throw new Error('WeRSS v1.5.2 文章列表桥接代码不符合预期')
    source = replaceOnce(source, component, component + '/* pussycat-content-bridge-v1 */')
    const clickStart = source.indexOf(',U=Ce=>{d.value=Ce,b.value.current=1,M.value=l.value.find(ne=>ne.id===d.value),console.log(M.value),H()},H=async()=>', source.indexOf(component))
    const clickEnd = source.indexOf(',W=ref(!1)', clickStart)
    if (clickStart < 0 || clickEnd < 0) throw new Error('WeRSS v1.5.2 文章请求桥接代码不符合预期')
    source = source.slice(0, clickStart) + ',U=Ce=>window.__PUSSYCAT_WRSS_BRIDGE__.selectView(Ce===""?"latest":Ce===FEATURED_MP_ID?"favorites":"account:"+Ce),H=()=>window.__PUSSYCAT_WRSS_BRIDGE__.fetchArticles()' + source.slice(clickEnd)
    const mountBefore = 'onMounted(()=>{console.log("\\u7EC4\\u4EF6\\u6302\\u8F7D\\uFF0C\\u5F00\\u59CB\\u83B7\\u53D6\\u6570\\u636E"),G(),Dt().then(()=>{console.log("\\u516C\\u4F17\\u53F7\\u5217\\u8868\\u83B7\\u53D6\\u5B8C\\u6210"),H()}).catch(Ce=>{console.error("\\u521D\\u59CB\\u5316\\u5931\\u8D25:",Ce)})});const Dt=async()=>'
    const mountAt = source.indexOf(mountBefore, source.indexOf(component))
    const sourceEnd = source.indexOf(',Et=async Ce=>', mountAt)
    if (mountAt < 0 || sourceEnd < 0) throw new Error('WeRSS v1.5.2 公众号请求桥接代码不符合预期')
    const factory = CONTENT_BRIDGE_FACTORY_START + '(' + createWrssContentBridge.toString() + ')' + CONTENT_BRIDGE_FACTORY_END
    const replacement = 'window.__PUSSYCAT_WRSS_BRIDGE__=' + factory + '({articles:o,articleLoading:s,sources:l,sourceLoading:c,activeMpId:d,articlePagination:b,sourcePagination:g,sourceFilter:f,articleQuery:m,sourceQuery:v,articleFilter:C,activeFeed:M,getArticles,getSubscriptions,nextTick},window);onBeforeUnmount(()=>window.__PUSSYCAT_WRSS_BRIDGE__?.dispose());onMounted(()=>{G(),window.__PUSSYCAT_WRSS_BRIDGE__.fetchSources(),window.__PUSSYCAT_WRSS_BRIDGE__.selectView("latest")});const Dt=()=>window.__PUSSYCAT_WRSS_BRIDGE__.fetchSources()'
    source = source.slice(0, mountAt) + replacement + source.slice(sourceEnd)
  }
  if (source.includes(CONTENT_BRIDGE_FACTORY_START)) {
    const start = source.indexOf(CONTENT_BRIDGE_FACTORY_START)
    const end = source.indexOf(CONTENT_BRIDGE_FACTORY_END, start)
    if (end < 0 || source.indexOf(CONTENT_BRIDGE_FACTORY_START, start + 1) >= 0) throw new Error('WeRSS v1.5.2 文章桥接工厂代码不符合预期')
    const current = CONTENT_BRIDGE_FACTORY_START + '(' + createWrssContentBridge.toString() + ')' + CONTENT_BRIDGE_FACTORY_END
    source = source.slice(0, start) + current + source.slice(end + CONTENT_BRIDGE_FACTORY_END.length)
  }
  source = source.replace('U=Ce=>window.__PUSSYCAT_WRSS_BRIDGE__.selectView("account:"+Ce)', 'U=Ce=>window.__PUSSYCAT_WRSS_BRIDGE__.selectView(Ce===""?"latest":Ce===FEATURED_MP_ID?"favorites":"account:"+Ce)')
  source = source.replace('window.__PUSSYCAT_WRSS_BRIDGE__.fetchSources().then(()=>window.__PUSSYCAT_WRSS_BRIDGE__.selectView("latest"))', 'window.__PUSSYCAT_WRSS_BRIDGE__.fetchSources(),window.__PUSSYCAT_WRSS_BRIDGE__.selectView("latest")')
  const qrOriginal = 'createBaseVNode("img",{src:u.value,alt:"\\u5FAE\\u4FE1\\u6388\\u6743\\u4E8C\\u7EF4\\u7801"},null,8,_hoisted_4$1)'
  const qrInstalled = 'createBaseVNode("div",{class:"pussycat-qr-image",style:{position:"relative",width:"240px",margin:"0 auto"}},[createBaseVNode("img",{src:u.value,alt:"微信授权二维码",style:{width:"240px",height:"240px",imageRendering:"pixelated"}},null,8,["src"]),scanned.value?createBaseVNode("div",{class:"pussycat-qr-scanned",style:{position:"absolute",inset:"0",display:"grid",placeContent:"center",background:"rgba(255,255,255,.96)",color:"#222",fontSize:"18px",padding:"20px"}},"已扫码，请在手机上点击确认"):createCommentVNode("",!0)]),createBaseVNode("p",{class:"pussycat-qr-countdown"},scanned.value?"等待手机确认":remaining.value+" 秒后自动刷新",1)'
  const qrCurrent = `${qrInstalled},createBaseVNode("button",{class:"pussycat-qr-refresh",disabled:d.value||scanned.value,onClick:refreshQr},d.value?"正在刷新…":"刷新二维码")`
  if (source.includes(qrOriginal)) source = replaceOnce(source, qrOriginal, qrCurrent)
  else if (source.includes(qrInstalled) && !source.includes(qrCurrent)) source = replaceOnce(source, qrInstalled, qrCurrent)
  else if (!source.includes(qrCurrent)) throw new Error('WeRSS v1.5.2 页面代码不符合预期')
  return replaceOnce(source, 'const c=ref(l<3),d=N=>', 'const c=ref(!1),d=N=>')
}

function patchDriver(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  let patched = source.replace(/\r\n/g, '\n')
  const replaceMethod = (value, signature, nextSignature, replacement) => {
    const start = value.indexOf(signature)
    if (start < 0 || value.includes(replacement)) return value
    const end = value.indexOf(nextSignature, start)
    if (end < 0) throw new Error(`WeRSS v1.5.2 ${signature.trim()} 代码不符合预期`)
    return value.slice(0, start) + replacement + '\n' + value.slice(end)
  }
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
  patched = replaceMethod(patched, '    def GetHasCode(self):', '    async def extract_token_from_requests', QR_HAS_CODE)
  patched = replaceMethod(patched, '    def GetCode(self,CallBack=None,Notice=None):', '    wait_time=1', QR_GET_CODE)
  patched = replaceMethod(patched, '    def check_lock(self, timeout: int = 300) -> bool:', '    def set_lock(self):', QR_CHECK_LOCK)
  for (const method of [QR_CHECK_LOCK, QR_HAS_CODE, QR_GET_CODE]) {
    if (!patched.includes(method)) {
      const methodAnchor = patched.indexOf('    async def wxLogin(')
      if (methodAnchor < 0) throw new Error('WeRSS v1.5.2 wxLogin 代码不符合预期')
      patched = patched.slice(0, methodAnchor) + method + '\n' + patched.slice(methodAnchor)
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

function patchWxBase(source) {
  const marker = '# pussycat_invalid_session_cleanup'
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  let patched = source.replace(/\r\n/g, '\n')
  const anchor = '        if code=="Invalid Session":\n'
  if (!patched.includes(anchor)) return source
  const cleanup = `            from driver.token import _save_to_local, REDIS_TOKEN_PREFIX
            from core.redis_client import redis_client
            setStatus(False)  # pussycat_invalid_session_cleanup
            _save_to_local({})
            if redis_client.is_connected:
                redis_client._client.delete(REDIS_TOKEN_PREFIX + "data")
`
  if (!patched.includes(marker)) patched = patched.replace(anchor, anchor + cleanup)
  patched = patched.replace(
    '            raise Exception(error)\n        # raise Exception(error)',
    '            from core.pussycat_sync import raise_sync_error\n            raise_sync_error(40101, error)\n        # raise Exception(error)',
  )
  return patched.replace(/\n/g, newline)
}

function patchWxModel(source) {
  const marker = '# pussycat_sync_network_contract'
  if (source.includes(marker)) return source
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  let patched = source.replace(/\r\n/g, '\n')
  const loopAnchor = '            begin = i * count\n            params["begin"] = str(begin)'
  if (!patched.includes(loopAnchor)) return source
  patched = patched.replace(
    loopAnchor,
    `${loopAnchor}\n            from core.pussycat_sync import ensure_sync_allowed  # pussycat_sync_network_contract\n            ensure_sync_allowed()`,
  )
  patched = patched.replace(
    /([ \t]+)msg\s*=\s*resp\.json\(\)\n/,
    `$&$1ret = int(msg.get("base_resp", {}).get("ret", 0))\n$1if ret == 200013:\n$1    from core.pussycat_sync import raise_sync_error\n$1    raise_sync_error(200013, "微信请求频率受限")\n$1if ret == 200003:\n$1    super().Error("Invalid Session", code="Invalid Session")\n$1if ret != 0:\n$1    from core.pussycat_sync import raise_sync_error\n$1    raise_sync_error(ret, "错误原因:{}:代码:{}".format(msg.get("base_resp", {}).get("err_msg", ""), ret))\n`,
  )
  patched = patched.replace(
    'session.get(url, headers=headers, params = params, verify=False)',
    'session.get(url, headers=headers, params=params, verify=False, timeout=(5, 10))',
  )
  patched = patched.replace(
    'super().Error("frequencey control, stop at {}".format(str(begin)))\n                    break',
    'from core.pussycat_sync import raise_sync_error\n                    raise_sync_error(200013, "微信请求频率受限")',
  )
  patched = patched.replace(
    'super().Error("Invalid Session, stop at {}".format(str(begin)),code="Invalid Session")\n                    break',
    'super().Error("Invalid Session, stop at {}".format(str(begin)),code="Invalid Session")',
  )
  patched = patched.replace(
    'super().Error("错误原因:{}:代码:{}".format(msg[\'base_resp\'][\'err_msg\'],msg[\'base_resp\'][\'ret\']),code=msg[\'base_resp\'][\'err_msg\'])\n                    break',
    'from core.pussycat_sync import raise_sync_error\n                    raise_sync_error(msg["base_resp"]["ret"], "错误原因:{}:代码:{}".format(msg["base_resp"]["err_msg"], msg["base_resp"]["ret"]))',
  )
  patched = patched.replace(
    'except requests.exceptions.Timeout:\n                print("Request timed out")\n                break',
    'except requests.exceptions.Timeout as error:\n                from core.pussycat_sync import raise_sync_error\n                raise_sync_error(50400, "微信请求超时: {}".format(error))',
  )
  patched = patched.replace(
    'except requests.exceptions.RequestException as e:\n                print(f"Request error: {e}")\n                break',
    'except requests.exceptions.RequestException as error:\n                from core.pussycat_sync import raise_sync_error\n                raise_sync_error(50200, "微信网络请求失败: {}".format(error))',
  )
  return patched.replace(/\n/g, newline)
}

function patchSysInfo(source) {
  if (source.includes('"article_sync":article_sync_info()')) return source
  const anchor = '            "article":get_article_info(),'
  if (!source.includes(anchor)) return source
  return source.replace(
    anchor,
    `${anchor}\n            "article_sync":article_sync_info(),`,
  ).replace(
    '        from driver.token import get as get_val',
    '        from driver.token import get as get_val\n        from core.pussycat_sync import article_sync_info',
  )
}

const ARTICLE_API_PATCH = `\n# pussycat_favorite_at_api\n`

function patchArticleModel(source) {
  if (source.includes('pussycat_favorite_at')) return source
  const anchor = 'is_favorite = Column(Integer, default=0)'
  if (!source.includes(anchor)) return source
  return source.replace(anchor, anchor + '\n    favorite_at = Column(Integer, nullable=True, default=None)  # pussycat_favorite_at')
}

function patchArticleApi(source) {
  if (source.includes('pussycat_favorite_at_api')) return source
  if (!source.includes('only_favorite')) return source
  let patched = source
  patched = patched.replace('limit: int = Query(5', 'limit: int = Query(10').replace('default=5', 'default=10')
  patched = patched.replace('article.is_favorite = 1 if is_favorite else 0', 'article.is_favorite = 1 if is_favorite else 0\n        article.favorite_at = int(time.time()) if is_favorite else None  # pussycat_favorite_at_api')
  if (!patched.includes('import time')) patched = patched.replace('from fastapi', 'import time\nfrom fastapi', 1)
  patched = patched.replace('query = query.filter(Article.is_favorite == 1)', 'query = query.filter(Article.is_favorite == 1)\n            query = query.order_by(Article.favorite_at.desc().nullslast(), Article.publish_time.desc())  # pussycat_favorite_at_api')
  patched = patched.replace('article_dict["is_favorite"] = int(getattr(article, "is_favorite", 0) or 0)', 'article_dict["is_favorite"] = int(getattr(article, "is_favorite", 0) or 0)\n            article_dict["favorite_at"] = getattr(article, "favorite_at", None)  # pussycat_favorite_at_api')
  return patched
}

function patchArticleDb(source) {
  if (source.includes('pussycat_favorite_at_migration')) return source
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const normalized = source.replace(/\r\n/g, '\n')
  const anchor = '            if "is_favorite" not in columns:\n                alter_statements.append("ALTER TABLE articles ADD COLUMN is_favorite INTEGER DEFAULT 0")'
  if (!normalized.includes(anchor)) return source
  const replacement = anchor + '\n            if "favorite_at" not in columns:\n                alter_statements.append("ALTER TABLE articles ADD COLUMN favorite_at INTEGER")  # pussycat_favorite_at_migration'
  return normalized.replace(anchor, replacement).replace(/\n/g, newline)
}

function patchMpsApi(source) {
  const oldCatch = `    except Exception as e:\n        print(f"搜索公众号错误: {str(e)}")\n        raise HTTPException(\n            status_code=status.HTTP_201_CREATED,\n            detail=error_response(\n                code=50001,\n                message=f"搜索公众号失败,请重新扫码授权！",\n            )\n        )`
  const newCatch = `    except HTTPException:\n        raise\n    except Exception as e:\n        print(f"搜索公众号错误: {str(e)}")\n        if "Invalid Session" in str(e) or "登录失效" in str(e):\n            from driver.success import setStatus\n            setStatus(False)\n            raise HTTPException(\n                status_code=status.HTTP_401_UNAUTHORIZED,\n                detail=error_response(code=40101, message="微信公众号授权已失效，请重新扫码授权"),\n            )\n        raise HTTPException(\n            status_code=status.HTTP_502_BAD_GATEWAY,\n            detail=error_response(\n                code=50002,\n                message="搜索公众号失败，请稍后重试",\n            )\n        )`
  const rewriteCatch = (value) => value.includes(oldCatch) ? value.replace(oldCatch, newCatch) : value
  source = patchMpsArticleCounts(source)
  if (!source.includes('# pussycat_sync_task_api')) {
    const start = source.indexOf('@router.get("/update/{mp_id}"')
    const end = start < 0 ? -1 : source.indexOf('@router.get("/{mp_id}"', start)
    if (start >= 0 && end < 0) throw new Error('WeRSS v1.5.2 公众号更新接口代码不符合预期')
    if (start >= 0) {
    const routes = `@router.get("/update/tasks/{task_id}", summary="查询公众号文章更新任务")\nasync def get_update_task(task_id: str, current_user: dict = Depends(get_current_user_or_ak)):\n    from core.pussycat_sync import get_sync_task\n    task = get_sync_task(task_id)\n    if task is None:\n        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_response(code=40404, message="任务不存在"))\n    return success_response(task)\n\n@router.get("/update/{mp_id}", summary="更新公众号文章")\nasync def update_mps(\n    mp_id: str,\n    start_page: int = 0,\n    end_page: int = 1,\n    current_user: dict = Depends(get_current_user_or_ak)\n):\n    # pussycat_sync_task_api\n    from core.models.feed import Feed\n    from core.pussycat_sync import submit_sync\n    session = DB.get_session()\n    try:\n        mp = session.query(Feed).filter(Feed.id == mp_id).first()\n        if not mp:\n            return error_response(code=40401, message="请选择一个公众号")\n        task = submit_sync(mp_id, start_page, end_page)\n        return success_response({\n            "time_span": 0,\n            "list": [],\n            "total": 0,\n            "mps": {"id": mp.id, "mp_name": mp.mp_name},\n            **task,\n        })\n    finally:\n        session.close()\n\n`
      source = source.slice(0, start) + routes + source.slice(end)
    }
  }
  source = source.replace(
    'mpx_id = base64.b64decode(mp_id).decode("utf-8")',
    'mpx_id = base64.b64decode(mp_id, validate=True).decode("utf-8").strip()\n        if not mpx_id:\n            raise ValueError("公众号标识无效")',
  )
  const oldAddQueue = `            from core.queue import TaskQueue\n            from core.wx import WxGather\n            Max_page=int(cfg.get("max_page","2"))\n            TaskQueue.add_task(WxGather().Model().get_Articles, faker_id=feed.faker_id, Mps_id=feed.id, CallBack=UpdateArticle, MaxPage=Max_page, Mps_title=mp_name, task_name=mp_name)`
  const newAddQueue = `            from core.pussycat_sync import submit_sync\n            Max_page=int(cfg.get("max_page","2"))\n            sync_task = submit_sync(feed.id, 0, Max_page)`
  if (source.includes(oldAddQueue)) source = source.replace(oldAddQueue, newAddQueue)
  source = source.replace(
    '            submit_sync(feed.id, 0, Max_page)',
    '            sync_task = submit_sync(feed.id, 0, Max_page)',
  )
  source = source.replace(
    '            "created_at": feed.created_at.isoformat()\n',
    '            "created_at": feed.created_at.isoformat(),\n            "sync_task": sync_task if not existing_feed else None\n',
  )
  const addGuard = (value, name, marker) => {
    if (value.includes(marker)) return value
    const match = new RegExp(`^(\\s*)(async\\s+def|def)\\s+${name}\\s*\\(`, 'm').exec(value)
    if (!match) return value
    let depth = 0
    let start = -1
    for (let index = match.index + match[0].length - 1; index < value.length; index++) {
      if (value[index] === '(') depth++
      if (value[index] === ')') depth--
      if (depth === 0) {
        const colon = value.indexOf(':', index + 1)
        if (colon < 0 || value.slice(index + 1, colon).trim()) return value
        start = colon + 1
        break
      }
    }
    if (start < 0) return value
    const bodyIndent = `${match[1]}    `
    const guard = `${bodyIndent}${marker}\n${bodyIndent}from driver.success import getStatus\n${bodyIndent}if not getStatus():\n${bodyIndent}    raise HTTPException(\n${bodyIndent}        status_code=status.HTTP_401_UNAUTHORIZED,\n${bodyIndent}        detail=error_response(code=40101, message="微信公众号授权已失效，请重新扫码授权"),\n${bodyIndent}    )\n`
    return value.slice(0, start) + `\n${guard}` + value.slice(start)
  }
  source = addGuard(source, 'search_mp', '# pussycat_authorization_guard')
  source = addGuard(source, 'update_mps', '# pussycat_update_authorization_guard')
  return rewriteCatch(source)
}

function patchMpsArticleCounts(source) {
  if (source.includes('# pussycat_article_count')) return source
  const importAnchor = 'from core.models.feed import FEATURED_MP_ID, FEATURED_MP_NAME, FEATURED_MP_INTRO'
  const queryAnchor = '        mps_list = [{'
  const itemAnchor = '                "created_at": mp.created_at.isoformat()'
  if (!source.includes(importAnchor) || !source.includes(queryAnchor) || !source.includes(itemAnchor)) return source
  let patched = source.replace(importAnchor, `${importAnchor}\nfrom sqlalchemy import func  # pussycat_article_count`)
  patched = patched.replace(queryAnchor, '        from core.models.article import Article\n        mp_ids = [mp.id for mp in mps]\n        counts = dict(session.query(Article.mp_id, func.count(Article.id)).filter(Article.mp_id.in_(mp_ids), Article.status != DATA_STATUS.DELETED).group_by(Article.mp_id).all()) if mp_ids else {}  # pussycat_article_count\n        mps_list = [{')
  return patched.replace(itemAnchor, `${itemAnchor},\n                "article_count": int(counts.get(mp.id, 0))  # pussycat_article_count`)
}

export function ensureWrssSourcePatches(sourceDir) {
  const bundlePath = join(sourceDir, 'static', 'assets', 'index.a75a6e55.js')
  const driverPath = join(sourceDir, 'driver', 'wx.py')
  const loginStatusPath = join(sourceDir, 'driver', 'success.py')
  const wechatStatusPath = join(sourceDir, 'static', 'assets', 'WechatStatus.62cf3d3b.js')
  const authApiPath = join(sourceDir, 'apis', 'auth.py')
  const mpsApiPath = join(sourceDir, 'apis', 'mps.py')
  const articleModelPath = join(sourceDir, 'core', 'models', 'article.py')
  const articleApiPath = join(sourceDir, 'apis', 'article.py')
  const dbPath = join(sourceDir, 'core', 'db.py')
  const wxBasePath = join(sourceDir, 'core', 'wx', 'base.py')
  const sysInfoPath = join(sourceDir, 'apis', 'sys_info.py')
  const wxModelPaths = ['api.py', 'app.py', 'web.py'].map(name => join(sourceDir, 'core', 'wx', 'model', name))
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
  const articleModel = existsSync(articleModelPath) ? readFileSync(articleModelPath, 'utf8') : null
  const patchedArticleModel = articleModel === null ? null : patchArticleModel(articleModel)
  const articleApi = existsSync(articleApiPath) ? readFileSync(articleApiPath, 'utf8') : null
  const patchedArticleApi = articleApi === null ? null : patchArticleApi(articleApi)
  const db = existsSync(dbPath) ? readFileSync(dbPath, 'utf8') : null
  const patchedDb = db === null ? null : patchArticleDb(db)
  const wxBase = existsSync(wxBasePath) ? readFileSync(wxBasePath, 'utf8') : null
  const patchedWxBase = wxBase === null ? null : patchWxBase(wxBase)
  const sysInfo = existsSync(sysInfoPath) ? readFileSync(sysInfoPath, 'utf8') : null
  const patchedSysInfo = sysInfo === null ? null : patchSysInfo(sysInfo)
  const wxModels = wxModelPaths.map(path => existsSync(path) ? readFileSync(path, 'utf8') : null)
  const patchedWxModels = wxModels.map(value => value === null ? null : patchWxModel(value))
  if (bundle !== patchedBundle) writeFileSync(bundlePath, patchedBundle, 'utf8')
  if (driver !== patchedDriver) writeFileSync(driverPath, patchedDriver, 'utf8')
  if (loginStatus !== patchedLoginStatus) writeFileSync(loginStatusPath, patchedLoginStatus, 'utf8')
  if (wechatStatus !== patchedWechatStatus) writeFileSync(wechatStatusPath, patchedWechatStatus, 'utf8')
  if (mps !== null && mps !== patchedMps) writeFileSync(mpsApiPath, patchedMps, 'utf8')
  if (articleModel !== null && articleModel !== patchedArticleModel) writeFileSync(articleModelPath, patchedArticleModel, 'utf8')
  if (articleApi !== null && articleApi !== patchedArticleApi) writeFileSync(articleApiPath, patchedArticleApi, 'utf8')
  if (db !== null && db !== patchedDb) writeFileSync(dbPath, patchedDb, 'utf8')
  if (wxBase !== null && wxBase !== patchedWxBase) writeFileSync(wxBasePath, patchedWxBase, 'utf8')
  if (sysInfo !== null && sysInfo !== patchedSysInfo) writeFileSync(sysInfoPath, patchedSysInfo, 'utf8')
  wxModelPaths.forEach((path, index) => {
    if (wxModels[index] !== null && wxModels[index] !== patchedWxModels[index]) writeFileSync(path, patchedWxModels[index], 'utf8')
  })
  mkdirSync(join(sourceDir, 'core'), { recursive: true })
  writeFileSync(join(sourceDir, 'core', 'pussycat_sync.py'), readFileSync(new URL('./wrss-sync.py', import.meta.url)))
  if (existsSync(authApiPath)) {
    let authApi = readFileSync(authApiPath, 'utf8')
    if (!authApi.includes('async def refresh_qrcode(')) {
      const routeStart = authApi.indexOf('@router.get("/qr/code"')
      const routeEnd = authApi.indexOf('@router.post("/login"', routeStart)
      if (routeStart >= 0 && routeEnd > routeStart) authApi = `${authApi.slice(0, routeStart)}${QR_AUTH_ROUTES}\n${authApi.slice(routeEnd)}`
    }
    if (!authApi.includes('async def logout_wechat(')) authApi = `${authApi}\n${WECHAT_LOGOUT}`
    if (authApi !== readFileSync(authApiPath, 'utf8')) writeFileSync(authApiPath, authApi, 'utf8')
  }
  writeFileSync(join(sourceDir, 'static', 'pussycat-auth.js'), readFileSync(new URL('./wrss-auth.js', import.meta.url)))
}
