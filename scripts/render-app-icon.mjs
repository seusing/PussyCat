// 由 src-tauri/icons/source/app-icon.svg 生成 Tauri 全套图标与 public/app-icon.png。
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const svg = readFileSync(join(root, 'src-tauri/icons/source/app-icon.svg'), 'utf8')
const tmp = mkdtempSync(join(tmpdir(), 'app-icon-'))

const browser = await chromium.launch()
try {
  const render = async (size, path) => {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`)
    await page.screenshot({ path, omitBackground: true })
    await page.close()
  }
  const master = join(tmp, 'app-icon.png')
  await render(1024, master)
  await render(512, join(root, 'public/app-icon.png'))
  execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', master, '-o', join(root, 'src-tauri/icons')], { stdio: 'inherit' })
} finally {
  await browser.close()
  rmSync(tmp, { recursive: true, force: true })
}
