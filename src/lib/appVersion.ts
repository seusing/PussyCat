/** 侧栏的短版本号。 */
export const APP_VERSION_LABEL = `v${__APP_VERSION__}`

/** 状态浮层里的完整版本:提交号取不到(源码压缩包构建)时省略。 */
export function formatAppBuild(
  version = __APP_VERSION__,
  commit = __APP_COMMIT__,
  date = __APP_BUILD_DATE__,
): string {
  return `${version}（${commit ? `${commit}，` : ''}${date} 构建）`
}
