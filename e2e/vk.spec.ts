import { expect, test } from '@playwright/test'

// 真栈 UI E2E:vite(node 模式)→ 真 Node Host(43199)→ 真 Python sidecar(stub LLM)。
const HOST = 'http://127.0.0.1:43199'
const ORIGIN = 'http://localhost:5199'

const SRT = `1
00:00:00,000 --> 00:00:04,000
相对论引言,介绍背景。

2
00:00:04,200 --> 00:00:09,500
光速在真空中约为每秒三十万公里。
`

async function uploadFixture(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const response = await request.post(`${HOST}/vk/v1/uploads?name=lecture.srt`, {
    headers: { Origin: ORIGIN, 'Content-Type': 'application/octet-stream' },
    data: Buffer.from(SRT, 'utf8'),
  })
  expect(response.status()).toBe(201)
  const body = await response.json()
  return `upload:${body.upload_id}`
}

test.describe('视频解析标签页', () => {
  test('宽屏:第三标签可达,表单齐备', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await page.getByTestId('module-tab-vk').click()
    await expect(page.getByTestId('vk-panel')).toBeVisible()
    for (const id of ['vk-source', 'vk-preset', 'vk-media-policy', 'vk-max-cost', 'vk-preview-button', 'vk-submit-button', 'vk-query-input']) {
      await expect(page.getByTestId(id)).toBeVisible()
    }
    await expect(page.getByTestId('vk-health-summary')).toContainText(/就绪|启动中|检测中/)
  })

  test('窄屏:功能完整可用', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 })
    await page.goto('/')
    await page.getByTestId('module-tab-vk').click()
    await expect(page.getByTestId('vk-panel')).toBeVisible()
    await page.getByTestId('vk-source').fill('https://example.com/x')
    await expect(page.getByTestId('vk-preview-button')).toBeEnabled()
    await page.getByTestId('vk-query-input').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('vk-query-input')).toBeVisible()
  })

  test('键盘:Tab 序可达视频解析标签并以键盘激活', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('module-tab-vk').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('module-tab-vk')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('vk-panel')).toBeVisible()
    // 表单内 Tab 前进不困死
    await page.getByTestId('vk-source').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('vk-preset')).toBeFocused()
  })

  test('错误恢复:坏 upload 源在提交边界报类型化错,修正后恢复', async ({ page, request }) => {
    await page.goto('/')
    await page.getByTestId('module-tab-vk').click()
    // 契约语义:preview 不解析 upload 源(合法字符串→预检成功),坏 id 在提交边界 404
    await page.getByTestId('vk-source').fill('upload:up_does_not_exist')
    await page.getByTestId('vk-preview-button').click()
    await expect(page.getByTestId('vk-preview')).toBeVisible()
    await page.getByTestId('vk-submit-button').click()
    await page.getByTestId('vk-cost-confirm').click()
    await expect(page.getByTestId('vk-submit-error')).toBeVisible()
    await expect(page.getByTestId('vk-submit-error')).toContainText('unknown upload id')
    // 修正:真实上传源 → 重新预检提交 → 任务出现,应用未被错误卡死
    const source = await uploadFixture(request)
    await page.getByTestId('vk-source').fill(source)
    await page.getByTestId('vk-preview-button').click()
    await expect(page.getByTestId('vk-preview')).toBeVisible()
    await page.getByTestId('vk-submit-button').click()
    await page.getByTestId('vk-cost-confirm').click()
    await expect(page.getByTestId('vk-job-row').first()).toBeVisible({ timeout: 30_000 })
  })

  test('闭环:预检→费用确认→提交→完成→产物→知识库查询', async ({ page, request }) => {
    const source = await uploadFixture(request)
    await page.goto('/')
    await page.getByTestId('module-tab-vk').click()
    await page.getByTestId('vk-source').fill(source)
    await page.getByTestId('vk-max-cost').fill('5')
    await page.getByTestId('vk-cap-query_ready').check() // 建索引,查询才有引用
    await page.getByTestId('vk-preview-button').click()
    await expect(page.getByTestId('vk-preview')).toBeVisible()
    await expect(page.getByTestId('vk-preview-estimates')).toContainText('¥0.25 – ¥1.06')

    await page.getByTestId('vk-submit-button').click()
    await expect(page.getByTestId('vk-cost-dialog')).toBeVisible()
    await expect(page.getByTestId('vk-cost-dialog')).toContainText('估算不是承诺')
    await expect(page.getByTestId('vk-cost-cap')).toContainText('¥5')
    await page.getByTestId('vk-cost-confirm').click()

    // 任务出现并在真 DAG 上完成(stub LLM,秒级)
    await expect(page.getByTestId('vk-job-row').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('vk-job-row').first()).toContainText('已完成', { timeout: 120_000 })
    await expect(page.getByTestId('vk-job-row').first()).toContainText('实际费用')

    // 详情:证据覆盖 + 产物按钮
    await page.getByTestId('vk-job-row').first().getByRole('button', { name: '详情' }).click()
    await expect(page.getByTestId('vk-job-detail')).toBeVisible()
    await expect(page.getByTestId('vk-output-note')).toBeVisible()

    // 知识库查询(真 FTS,带引用)
    await page.getByTestId('vk-query-input').fill('光速')
    await page.getByTestId('vk-query-button').click()
    await expect(page.getByTestId('vk-query-answer')).toBeVisible()
    await expect(page.getByTestId('vk-query-citation').first()).toBeVisible()
  })
})
