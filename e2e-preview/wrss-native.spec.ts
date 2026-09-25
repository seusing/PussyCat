import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("native WeRSS authorization, empty sync, navigation, and recovery", async ({ page, request }) => {
  const errors: string[] = [];
  let apiOrigin = "";
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)"))
      errors.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (!apiOrigin && response.url().includes("/vk/v1/integrations/wrss"))
      apiOrigin = new URL(response.url()).origin;
  });

  await page.goto("/");
  await page.getByTestId("startup-splash").click();
  await page.getByTestId("module-tab-wrss").click();
  const workspace = page.getByTestId("wrss-native");
  await expect(workspace).toBeVisible();
  await expect.poll(() => apiOrigin).not.toBe("");
  await request.post(`${apiOrigin}/wrss/api/auth/wechat/logout`);
  await page.reload();
  await page.getByTestId("startup-splash").click();
  await page.getByTestId("module-tab-wrss").click();
  await expect(workspace.getByTestId("wrss-unauthorized")).toBeVisible();
  await expect(workspace.getByTestId("wrss-article-list")).toHaveCount(0);
  await expect(workspace.getByLabel("公众号叠卡")).toHaveCount(0);
  await request.post(`${apiOrigin}/wrss/mock/empty`);

  await workspace.getByRole("button", { name: "更多" }).click();
  const menu = workspace.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.width).toBeLessThanOrEqual(300);
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await workspace.getByRole("button", { name: "更多" }).click();
  await workspace.getByRole("button", { name: "授权管理" }).click();
  await workspace.getByRole("button", { name: "开始模拟授权" }).click();
  const dialog = workspace.getByRole("dialog", { name: "微信扫码授权" });
  await expect(dialog.getByAltText("微信授权二维码")).toBeVisible();
  await dialog.getByRole("button", { name: "模拟扫码" }).click();
  await expect(dialog.getByText("二维码已锁定")).toBeVisible();
  await dialog.getByRole("button", { name: "模拟确认" }).click();
  await expect(workspace.locator(".wrss-native-title")).toContainText("已授权");
  await expect(workspace.locator(".wrss-native-title")).not.toContainText("未授权");

  const cards = workspace.locator(".wrss-native-articles article");
  await expect(cards).toHaveCount(10, { timeout: 15_000 });
  await expect(cards.first()).toContainText("自动获取文章 1");
  const articleRequests = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name)
      .filter((name) => name.includes("/wrss/api/articles?")),
  );
  expect(articleRequests.some((url) =>
    url.includes("offset=0&limit=10&search=") &&
    !url.includes("only_favorite") && !url.includes("mp_id"),
  )).toBe(true);

  const latest = workspace.getByRole("button", { name: "最新文章" });
  const favorites = workspace.getByRole("button", { name: "我的收藏" });
  const sources = workspace.getByRole("button", { name: "已订阅公众号" });
  for (let index = 0; index < 20; index++)
    await (index % 3 === 0 ? latest : index % 3 === 1 ? favorites : sources).click();
  await sources.click();
  await page.waitForTimeout(360);
  await expect(workspace.locator(".wrss-view-pane.is-active")).toHaveCount(1);
  await expect(workspace.locator(".wrss-view-pane.is-leaving")).toHaveCount(0);
  const deck = workspace.getByLabel("公众号叠卡");
  await expect(deck).toBeVisible();
  const activeSource = workspace.locator('.wrss-source-main[aria-current="true"]');
  const nextSource = workspace.locator(".wrss-source-main").nth(1);
  await expect(activeSource).toBeVisible();
  const beforeSource = await activeSource.textContent();
  const activeBox = await activeSource.boundingBox();
  const nextBox = await nextSource.boundingBox();
  expect(activeBox).not.toBeNull();
  expect(nextBox).not.toBeNull();
  await page.mouse.click(nextBox!.x + 30,
    (activeBox!.y + activeBox!.height + nextBox!.y + nextBox!.height) / 2);
  await expect(activeSource).not.toHaveText(beforeSource ?? "");

  await page.setViewportSize({ width: 960, height: 600 });
  await workspace.getByRole("button", { name: "更多" }).click();
  const narrowMenuBox = await menu.boundingBox();
  expect(narrowMenuBox).not.toBeNull();
  expect(narrowMenuBox!.x).toBeGreaterThanOrEqual(0);
  expect(narrowMenuBox!.y + narrowMenuBox!.height).toBeLessThanOrEqual(600);
  expect(await workspace.evaluate((node) => node.scrollWidth === node.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await latest.click();
  await favorites.click();
  await page.waitForTimeout(30);
  expect(await workspace.locator(".wrss-view-pane,.wrss-source-card").evaluateAll(
    (nodes) => nodes.reduce((count, node) => count + node.getAnimations().length, 0),
  )).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await latest.click();
  const firstArticle = workspace.locator(".wrss-article-title").first();
  await expect(firstArticle).toBeVisible();
  const retainedTitle = await firstArticle.textContent();
  await request.post(`${apiOrigin}/wrss/mock/fail-next`);
  await workspace.getByRole("button", { name: "刷新文章列表" }).click();
  const alert = workspace.getByRole("alert");
  await expect(alert).toContainText("预览请求失败，请重试");
  await expect(firstArticle).toHaveText(retainedTitle ?? "");
  await alert.getByRole("button", { name: "重试" }).click();
  await expect(alert).toBeHidden();

  const fontStatus = await page.evaluate(async () => {
    await document.fonts.load('oblique 700 16px "Helvetica"');
    return [...document.fonts].find((face) => face.family === "Helvetica")?.status;
  });
  expect(fontStatus).toBe("loaded");
  await workspace.getByRole("button", { name: "更多" }).click();
  await workspace.getByRole("button", { name: "授权管理" }).click();
  await workspace.getByRole("button", { name: "退出模拟授权" }).click();
  await expect(workspace.getByTestId("wrss-unauthorized")).toBeVisible();
  await expect(workspace.getByTestId("wrss-article-list")).toHaveCount(0);
  await expect(workspace.getByLabel("公众号叠卡")).toHaveCount(0);

  await mkdir("artifacts/wrss-fix-20260918", { recursive: true });
  await page.screenshot({ path: "artifacts/wrss-fix-20260918/preview-final.png", fullPage: true });
  expect(errors).toEqual([]);
});
