import { expect, test } from '@playwright/test'

// 连接状态胶囊的悬浮区域。
//
// 这里必须用 e2e 而不是 vitest:漏洞出在**命中测试**上,jsdom 没有布局引擎,
// mouseleave 在那边永远只按 DOM 层级算,复现不出来。
//
// 卡片从胶囊上方展开,并由透明的 pb-2「桥」覆盖胶囊与卡片之间的间隙。
//
// 因此这条用例的关键不是"能不能悬浮出卡片",而是**必须分步走过那条缝**:
// Playwright 的 hover() 是瞬移,直接落在卡片里不经过缝隙,带着漏洞也会通过。
test.describe('连接状态胶囊', () => {
  test('鼠标从结论移到卡片里的按钮,中途不收起 —— 缝隙不能断开悬浮', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')

    const pill = page.getByTestId('health-pill')
    await expect(pill).toBeVisible()
    await pill.hover()

    const card = page.getByTestId('health-details')
    await expect(card).toBeVisible()

    const pillBox = (await pill.boundingBox())!
    const cardBox = (await card.boundingBox())!
    expect(cardBox.y + cardBox.height).toBeLessThan(pillBox.y)   // 卡片确实在上方且有间距

    // 沿真实路径逐步向上移动,必然穿过那条缝。steps 少了会跳过去,测不出东西。
    await page.mouse.move(pillBox.x + pillBox.width / 2, pillBox.y + pillBox.height / 2)
    await page.mouse.move(
      cardBox.x + cardBox.width / 2,
      cardBox.y + 6,
      { steps: 30 },
    )
    await expect(card).toBeVisible()
  })

  test('鼠标离开整块(胶囊 + 卡片)才收起', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')

    const pill = page.getByTestId('health-pill')
    await pill.hover()
    await expect(page.getByTestId('health-details')).toBeVisible()

    // 移到页面另一头 —— 这才叫离开。
    await page.mouse.move(40, 600, { steps: 20 })
    await expect(page.getByTestId('health-details')).toBeHidden({ timeout: 1000 })
  })
})
