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

async function exposeConfiguredStubProvider(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/vk/v1/providers', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, json: { ...body, configured: true } })
  })
}

async function openAdvanced(page: import('@playwright/test').Page): Promise<void> {
  const details = page.getByTestId('vk-advanced-settings')
  if ((await details.getAttribute('open')) === null) await details.locator(':scope > summary').click()
}

async function openDeveloper(page: import('@playwright/test').Page): Promise<void> {
  await openAdvanced(page)
  const details = page.getByTestId('vk-developer-settings')
  if ((await details.getAttribute('open')) === null) await details.locator(':scope > summary').click()
}

test.describe('视频解析标签页', () => {
  test('宽屏:第三标签可达,表单齐备', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await page.getByTestId('module-tab-vk').click()
    await expect(page.getByTestId('vk-panel')).toBeVisible()
    for (const id of ['vk-source', 'vk-submit-button', 'vk-query-input']) {
      await expect(page.getByTestId(id)).toBeVisible()
    }
    await expect(page.getByTestId('vk-preset')).not.toBeVisible()
    await expect(page.getByTestId('vk-media-policy')).not.toBeVisible()
    await openAdvanced(page)
    await expect(page.getByTestId('vk-preset')).toBeVisible()
    await openDeveloper(page)
    await expect(page.getByTestId('vk-media-policy')).toBeVisible()
    await expect(page.getByTestId('vk-max-cost')).toBeVisible()
    await expect(page.getByTestId('vk-verdict')).toContainText(/解析引擎|模型配置/)
  })

  test('窄屏:功能完整可用', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 })
    await page.goto('/')
    await page.getByTestId('module-tab-vk').click()
    await expect(page.getByTestId('vk-panel')).toBeVisible()
    await expect(page.getByTestId('module-tab-commands')).toBeVisible()
    await expect(page.getByTestId('module-tab-login')).toBeVisible()
    await expect(page.getByTestId('health-details-toggle')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByTestId('vk-source').fill('https://example.com/x')
    await expect(page.getByTestId('vk-submit-button')).toBeEnabled()
    await expect(page.getByTestId('vk-submit-button')).toHaveText('开始解析')
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
    await expect(page.getByRole('button', { name: '导入链接文件' })).toBeFocused()
    const advanced = page.getByTestId('vk-advanced-settings')
    await advanced.locator(':scope > summary').focus()
    await page.keyboard.press('Enter')
    await expect(advanced).toHaveAttribute('open', '')
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('vk-preset')).toBeFocused()
  })

  test('错误恢复:坏 upload 源在提交边界报类型化错,修正后恢复', async ({ page, request }) => {
    await exposeConfiguredStubProvider(page)
    await page.goto('/')
    await page.getByTestId('module-tab-vk').click()
    // 契约语义:preview 不解析 upload 源(合法字符串→预检成功),坏 id 在提交边界 404
    await page.getByTestId('vk-source').fill('upload:up_does_not_exist')
    const failedSubmit = page.waitForResponse(
      (response) => response.url().endsWith('/vk/v1/jobs') && response.request().method() === 'POST',
    )
    await page.getByTestId('vk-submit-button').click()
    expect((await failedSubmit).status()).toBe(404)
    await expect(page.getByTestId('vk-submit-error')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('vk-submit-error')).toContainText('unknown upload id')
    // 修正:真实上传源 → 再次解析并提交 → 任务出现,应用未被错误卡死
    const source = await uploadFixture(request)
    await page.getByTestId('vk-source').fill(source)
    await expect(page.getByTestId('vk-submit-button')).toBeEnabled()
    await page.getByTestId('vk-submit-button').click()
    await expect(page.getByTestId('vk-job-row').first()).toBeVisible({ timeout: 30_000 })
  })

  test('闭环:开始解析→内联预检/提交→完成→产物→知识库查询', async ({ page, request }) => {
    const source = await uploadFixture(request)
    await exposeConfiguredStubProvider(page)
    await page.goto('/')
    await page.getByTestId('module-tab-vk').click()
    await page.getByTestId('vk-source').fill(source)
    await openDeveloper(page)
    await expect(page.getByTestId('vk-max-cost')).toBeDisabled()
    await page.getByTestId('vk-cap-query_ready').check() // 建索引,查询才有引用
    const previewWatch = page.waitForResponse(
      (response) => response.url().endsWith('/vk/v1/preview') && response.request().method() === 'POST',
    )
    const submitWatch = page.waitForResponse(
      (response) => response.url().endsWith('/vk/v1/jobs') && response.request().method() === 'POST',
    )
    await page.getByTestId('vk-submit-button').click()
    const previewResponse = await previewWatch
    expect(previewResponse.status()).toBe(200)
    expect(await previewResponse.json()).toMatchObject({
      max_cost_cny: null,
      requested_capabilities: expect.arrayContaining(['query_ready']),
    })
    expect((await submitWatch).status()).toBe(201)

    // 任务出现并在真 DAG 上完成(stub LLM,秒级)
    await expect(page.getByTestId('vk-job-row').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('vk-job-row').first()).toContainText('已完成', { timeout: 120_000 })

    // 详情:证据覆盖 + 产物按钮
    await page.getByTestId('vk-job-row').first().click()
    const detail = page.getByTestId('vk-task-detail-sidebar')
    await expect(detail).toBeVisible()
    await expect(detail.getByRole('button', { name: '查看解析结果' })).toBeVisible()

    // 知识库查询(真 FTS,当前短样本返回证据不足状态)
    await page.getByTestId('vk-query-input').fill('光速')
    await page.getByTestId('vk-query-button').click()
    await expect(page.getByTestId('vk-query-answer')).toContainText('insufficient evidence')
  })
})

// v2 阶段5:用户真实入口 —— 从采集结果「送去视频解析」的跨模块完整流程。
//
// 生产实现:React/store/ResultsTable/VkPanel/Node vk 代理/sidecar/SQLite/DAG/产物读取。
// 仅在**网络边界**注入 OpenCLI 命令的执行结果(与 LLM 用确定性 provider 同类),
// 因为本用例要验的是「交接 → 解析闭环」,不是 opencli 自身的抓取。
test.describe('跨模块:采集结果 → 视频解析', () => {
  test('送去视频解析 → provenance + 凭据脱敏 → 内联预检/提交 → 历史刷新', async ({ page }) => {
    const SENTINEL = 'SENTINELxsec0123456789'
    const ROW_URL = `https://www.bilibili.com/video/BV1e2e?xsec_token=${SENTINEL}&p=1`
    let runId: string | null = null
    let eventsHit = 0

    await page.route('**/start', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}')
      runId = body.runId
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ runId }),
      })
    })
    await page.route('**/events', async (route) => {
      eventsHit += 1
      if (!runId) {
        // 首次连接发生在 /start 之前:先只回一条注释保持协议合法。
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': waiting\n\n' })
        return
      }
      const done = {
        runId, at: Date.now(), outcome: 'success', exitCode: 0,
        result: [{ rank: 1, title: '相对论科普', url: ROW_URL }],
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `id: 1\nevent: done\ndata: ${JSON.stringify(done)}\n\n`,
      })
    })

    await exposeConfiguredStubProvider(page)
    await page.goto('/')
    // 真实用户路径:导航选站点 → 选命令 → 执行(判决与表单全走生产实现)
    await page.getByTestId('nav-search').fill('bilibili')
    const hotCommand = page.getByTestId('command-row-bilibili/hot')
    const hotCommandHeader = hotCommand.getByRole('button').first()
    await hotCommandHeader.focus()
    await expect(hotCommandHeader).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('inspiration-execute')).toBeVisible()
    await expect(page.getByTestId('run-button')).toBeEnabled({ timeout: 15_000 })
    await page.getByTestId('run-button').click()
    // 该命令若需一次性确认,走产品自己的确认流程
    const ack = page.getByTestId('ack-confirm')
    if (await ack.isVisible().catch(() => false)) await ack.click()

    // 运行落地(SSE done 事件经生产 store/runMachine 归位),再切到表格页签
    await expect(page.getByTestId('run-state')).toContainText('已完成', { timeout: 40_000 })
    await page.getByRole('button', { name: '表格结果' }).click()
    await expect(page.getByTestId('results-table')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('send-to-vk-0')).toBeVisible()
    expect(eventsHit).toBeGreaterThan(0)

    // 交接:URL + 脱敏 provenance 进入视频页
    await page.getByTestId('send-to-vk-0').click()
    await expect(page.getByTestId('vk-panel')).toBeVisible()
    await expect(page.getByTestId('vk-provenance')).toContainText('/')
    expect(await page.getByTestId('vk-source').inputValue()).toContain('bilibili.com')

    // 内联预检:响应是公开投影,source 输入框与提交请求仍是执行通道,允许持有原始 URL
    await openDeveloper(page)
    await expect(page.getByTestId('vk-max-cost')).toBeDisabled()
    const previewWatch = page.waitForResponse(
      (response) => response.url().endsWith('/vk/v1/preview') && response.request().method() === 'POST',
    )
    const submitWatch = page.waitForResponse(
      (response) => response.url().endsWith('/vk/v1/jobs') && response.request().method() === 'POST',
    )
    await page.getByTestId('vk-submit-button').click()
    const previewResponse = await previewWatch
    expect(previewResponse.status()).toBe(200)
    expect(await previewResponse.text()).not.toContain(SENTINEL)
    expect(await page.getByTestId('vk-provenance').textContent()).not.toContain(SENTINEL)
    const submitResponse = await submitWatch
    const submitRequest = submitResponse.request()
    const submitJobId = (await submitResponse.json()).job_id

    // 任务落地:列表出现;job 视图 API 全文零哨兵(公开请求/影子/历史面)。
    // 注意取**本次**提交的那条:同一 sidecar 跨用例复用,列表里还有前面用例的任务。
    await expect(page.getByTestId('vk-job-row').first()).toBeVisible({ timeout: 30_000 })
    const submitBody = JSON.parse(submitRequest?.postData() ?? '{}')
    const jobId = String(submitJobId ?? '')
    expect(submitBody.request.source).toContain(SENTINEL)   // 执行通道确实带着原始 URL
    const viewUrl = `${HOST}/vk/v1/jobs/${encodeURIComponent(jobId).replace(/%3A/gi, ':')}`
    const raw = await (await page.request.get(viewUrl, { headers: { Origin: ORIGIN } })).text()
    expect(raw).not.toContain(SENTINEL)
    expect(raw).toContain('bilibili.com')      // 公开源保留(只剥凭据参数)

    // 历史面可刷新可见(retry/refresh 的历史重建由 vk 侧 8 测 + 安装态 E2E 覆盖)
    await page.getByTestId('vk-jobs-refresh').click()
    await expect(page.getByTestId('vk-job-row').first()).toBeVisible()
  })
})
