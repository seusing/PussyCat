import { CommandExecutionError } from '@jackwener/opencli/errors';

/** 是不是 App「分享 → 复制链接」得到的 xhslink.com / xhslink.cn 短链接（含子域）。 */
export function isXhsShortLink(raw) {
    try {
        const url = new URL(raw);
        return /^https?:$/.test(url.protocol) && /(^|\.)xhslink\.(com|cn)$/.test(url.hostname);
    } catch {
        return false;
    }
}

/** 只请求一次、读短链接自己的 Location，不跟随——匿名打开目标页会再跳到登录页。 */
export async function readXhsShortLink(raw, { fetch = globalThis.fetch } = {}) {
    try {
        const response = await fetch(raw, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
        const location = response.headers.get('location');
        return location ? new URL(location, raw).href : '';
    } catch (error) {
        throw new CommandExecutionError(
            `小红书短链接解析失败：${raw}（${error.message}）`,
            '检查网络后重试，或在浏览器打开这条短链接，把跳转后的地址粘贴进来',
        );
    }
}
