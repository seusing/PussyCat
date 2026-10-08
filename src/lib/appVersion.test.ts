import { APP_VERSION_LABEL, formatAppBuild } from './appVersion'

test('测试环境里的构建常量是钉死的值', () => {
  expect(__APP_VERSION__).toBe('1.2.3')
  expect(__APP_COMMIT__).toBe('abc1234')
  expect(__APP_BUILD_DATE__).toBe('2026-01-02')
})

test('侧栏版本带 v 前缀', () => {
  expect(APP_VERSION_LABEL).toBe('v1.2.3')
})

test('完整版本包含提交号与构建日期', () => {
  expect(formatAppBuild()).toBe('1.2.3（abc1234，2026-01-02 构建）')
})

test('取不到提交号时省略提交号', () => {
  expect(formatAppBuild('1.2.3', '', '2026-01-02')).toBe('1.2.3（2026-01-02 构建）')
})
