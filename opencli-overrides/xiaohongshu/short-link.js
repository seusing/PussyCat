import { CommandExecutionError } from '@jackwener/opencli/errors';

const XHS_LINK_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g;
const XHS_LINK_HOST = /(^|\.)(xiaohongshu\.com|xhslink\.(com|cn))$/;

/** 是不是 App「分享 → 复制链接」得到的 xhslink.com / xhslink.cn 短链接（含子域）。 */
export function isXhsShortLink(raw) {
    try {
        const url = new URL(raw);
        return /^https?:$/.test(url.protocol) && /(^|\.)xhslink\.(com|cn)$/.test(url.hostname);
    } catch {
        return false;
    }
}

/** 取出文本里第一条小红书链接（xiaohongshu.com / xhslink.com / xhslink.cn，含子域）；App 分享文案是「标题 + 链接 + 说明」，链接遇到中文或空白即止。 */
export function findXhsLink(text) {
    for (const [match] of String(text).matchAll(XHS_LINK_PATTERN)) {
        const candidate = match.replace(/[.,;:!?)'"\]]+$/, '');
        try {
            if (XHS_LINK_HOST.test(new URL(candidate).hostname)) return candidate;
        } catch {
            // 不是合法链接，继续看下一条。
        }
    }
    return null;
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
