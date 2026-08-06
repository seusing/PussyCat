import { expect, test } from '@playwright/test'

// 连接状态胶囊的悬浮区域。
//
// 这里必须用 e2e 而不是 vitest:漏洞出在**命中测试**上,jsdom 没有布局引擎,
// mouseleave 在那边永远只按 DOM 层级算,复现不出来。
//
// 原始症状:卡片与胶囊之间有 8px 视觉间距(卡片自己的 mt-2),那条缝上压着的是 header。
// 鼠标从胶囊往卡片走的一瞬,指针底下既不是胶囊也不是卡片 —— 根节点收到 mouseleave,
// 卡片当场收起,用户**永远够不到里面的「修复浏览器连接」**。
// 修法是外面套一层透明的 pt-2「桥」,把缝盖进根节点的盒子里。
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
    expect(cardBox.y).toBeGreaterThan(pillBox.y + pillBox.height)   // 卡片确实在下方且有间距

    // 沿真实路径逐步移动,必然穿过那条缝。steps 少了会跳过去,测不出东西。
    await page.mouse.move(pillBox.x + pillBox.width / 2, pillBox.y + pillBox.height / 2)
    await page.mouse.move(
      cardBox.x + cardBox.width / 2,
      cardBox.y + cardBox.height - 6,   // 奔卡片底部 —— 「修复浏览器连接」就在那儿
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
    await expect(page.getByTestId('health-details')).toBeHidden()
  })
})
