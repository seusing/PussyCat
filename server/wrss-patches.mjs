import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const AUTH_API = 'const QRCode=()=>window.__PUSSYCAT_WRSS_AUTH__.qrCode(),checkQRCodeStatus=()=>window.__PUSSYCAT_WRSS_AUTH__.checkStatus(),'
const AUTH_SETUP = `const c=ref(false),d=ref(false),u=ref(""),A=ref("");
let generation=0;
const f=()=>{generation++;window.__PUSSYCAT_WRSS_AUTH__.cancel();d.value=false;};
const g=async()=>{
  const current=++generation;
  c.value=true;d.value=true;u.value="";A.value="";
  try {
    const result=await QRCode();
    if(current!==generation)return;
    u.value=result.code;d.value=false;
    const status=await checkQRCodeStatus();
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
            print_info("正在加载登录页面...")
            await page.goto(self.WX_LOGIN, wait_until="domcontentloaded", timeout=20000)
            qr_tag = ".login__type__container__scan__qrcode"
            await page.wait_for_function(
                "selector => { const img = document.querySelector(selector); return img && img.complete && img.naturalWidth > 0; }",
                arg=qr_tag,
                timeout=15000,
            )
            qrcode = page.locator(qr_tag)
            code_src = await qrcode.get_attribute("src")
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
    const start = source.indexOf('let qrCodeIntervalId=')
    const end = source.indexOf('refreshToken=()=>http$1.post("/wx/auth/refresh")', start)
    if (start < 0 || end < 0) throw new Error('WeRSS v1.5.2 二维码接口代码不符合预期')
    source = source.slice(0, start) + AUTH_API + source.slice(end)
  }
  if (!source.includes(AUTH_SETUP)) {
    const component = '__name:"WechatAuthQrcode",emits:["success","error"],setup(a,{expose:o,emit:s}){'
    const start = source.indexOf(component)
    const end = source.indexOf('return o({startAuth:g})', start)
    if (start < 0 || end < 0 || !source.slice(start, end).includes('f=()=>{};')) {
      throw new Error('WeRSS v1.5.2 授权窗口代码不符合预期')
    }
    source = source.slice(0, start + component.length) + AUTH_SETUP + source.slice(end)
  }
  return replaceOnce(source, 'const c=ref(l<3),d=N=>', 'const c=ref(!1),d=N=>')
}

function patchDriver(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  let patched = source.replace(/\r\n/g, '\n')
  if (!patched.includes(QR_PAGE)) {
    const start = patched.indexOf('            await driver.open_url(self.WX_LOGIN)')
    const end = patched.indexOf('            print("正在生成二维码图片...")', start)
    if (start < 0 || end < 0) throw new Error('WeRSS v1.5.2 二维码生成代码不符合预期')
    patched = patched.slice(0, start) + QR_PAGE + patched.slice(end)
  }
  patched = replaceOnce(patched, 'await qrcode.screenshot(path=self.wx_login_url)', 'await qrcode.screenshot(path=self.wx_login_url, timeout=5000)')
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
  return replaceOnce(
    source,
    ';return onMounted(()=>{E.value&&B(),initBrowserNotification(),translatePage(),P()}',
    ';provide("pussycatWechatAuth",{login:_,info:y,refresh:P});return onMounted(()=>{E.value&&B(),initBrowserNotification(),translatePage(),P()}',
  )
}

function patchWechatStatus(source) {
  const before = 'setup(pe){const m=h(!1),o=h(null),F=h(!1),k=H("showAuthQrcode",()=>{r.warning("\\u8BF7\\u4ECE\\u9875\\u9762\\u5934\\u90E8\\u8FDB\\u884C\\u626B\\u7801\\u6388\\u6743")}),y=async()=>{var i,u;try{const c=await K();m.value=((i=c==null?void 0:c.wx)==null?void 0:i.login)||!1,o.value=((u=c==null?void 0:c.wx)==null?void 0:u.info)||null}catch(c){console.error("\\u83B7\\u53D6\\u7CFB\\u7EDF\\u4FE1\\u606F\\u5931\\u8D25",c)}}'
  const after = 'setup(pe){const {login:m,info:o,refresh:y}=H("pussycatWechatAuth"),F=h(!1),k=H("showAuthQrcode",()=>{r.warning("\\u8BF7\\u4ECE\\u9875\\u9762\\u5934\\u90E8\\u8FDB\\u884C\\u626B\\u7801\\u6388\\u6743")})'
  return replaceOnce(source, before, after)
}

export function ensureWrssSourcePatches(sourceDir) {
  const bundlePath = join(sourceDir, 'static', 'assets', 'index.a75a6e55.js')
  const driverPath = join(sourceDir, 'driver', 'wx.py')
  const loginStatusPath = join(sourceDir, 'driver', 'success.py')
  const wechatStatusPath = join(sourceDir, 'static', 'assets', 'WechatStatus.62cf3d3b.js')
  const bundle = readFileSync(bundlePath, 'utf8')
  const driver = readFileSync(driverPath, 'utf8')
  const loginStatus = readFileSync(loginStatusPath, 'utf8')
  const wechatStatus = readFileSync(wechatStatusPath, 'utf8')
  const patchedBundle = patchSharedWechatStatus(patchBundle(bundle))
  const patchedDriver = patchDriver(driver)
  const patchedLoginStatus = patchLoginStatus(loginStatus)
  const patchedWechatStatus = patchWechatStatus(wechatStatus)
  if (bundle !== patchedBundle) writeFileSync(bundlePath, patchedBundle, 'utf8')
  if (driver !== patchedDriver) writeFileSync(driverPath, patchedDriver, 'utf8')
  if (loginStatus !== patchedLoginStatus) writeFileSync(loginStatusPath, patchedLoginStatus, 'utf8')
  if (wechatStatus !== patchedWechatStatus) writeFileSync(wechatStatusPath, patchedWechatStatus, 'utf8')
  writeFileSync(join(sourceDir, 'static', 'pussycat-auth.js'), readFileSync(new URL('./wrss-auth.js', import.meta.url)))
}
