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

export function ensureWrssSourcePatches(sourceDir) {
  const bundlePath = join(sourceDir, 'static', 'assets', 'index.a75a6e55.js')
  const driverPath = join(sourceDir, 'driver', 'wx.py')
  const bundle = readFileSync(bundlePath, 'utf8')
  const driver = readFileSync(driverPath, 'utf8')
  const patchedBundle = patchBundle(bundle)
  const patchedDriver = patchDriver(driver)
  if (bundle !== patchedBundle) writeFileSync(bundlePath, patchedBundle, 'utf8')
  if (driver !== patchedDriver) writeFileSync(driverPath, patchedDriver, 'utf8')
  writeFileSync(join(sourceDir, 'static', 'pussycat-auth.js'), readFileSync(new URL('./wrss-auth.js', import.meta.url)))
}
