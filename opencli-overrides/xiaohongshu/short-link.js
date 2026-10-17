import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

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

const XHS_USER_ID = /^[0-9a-f]{24}$/i;
const PROFILE_HINT = '支持博主 ID、博主主页链接（www.xiaohongshu.com/user/profile/…），以及 App 里博主主页「分享 → 复制链接」得到的 xhslink 短链接';

/** 接受博主 id 或主页链接；主页链接里的 xsec_token 保留下来，部分主页不带它打不开。 */
export function parseXhsProfileTarget(input) {
    const raw = String(input ?? '').trim();
    if (!raw) throw new ArgumentError('请填写小红书博主 ID 或主页链接');
    let url = null;
    try {
        url = new URL(raw);
    } catch {
        url = null;
    }
    if (!url) {
        const userId = raw.replace(/[?#].*$/, '');
        if (!XHS_USER_ID.test(userId)) throw new ArgumentError('请填写小红书博主 ID 或主页链接', PROFILE_HINT);
        return { userId, xsecToken: '', xsecSource: '' };
    }
    const match = url.pathname.match(/\/user\/profile\/([^/]+)/);
    const userId = match ? match[1] : '';
    if (!userId) {
        throw new ArgumentError(`不是小红书博主主页链接：${raw}`, PROFILE_HINT);
    }
    return {
        userId,
        xsecToken: url.searchParams.get('xsec_token') || '',
        xsecSource: url.searchParams.get('xsec_source') || '',
    };
}

/** 在 parseXhsProfileTarget 之上多认 xhslink 短链接和带链接的分享文案：只请求一次、读它自己的 Location，不跟随——匿名打开主页会再跳到登录页。 */
export async function resolveXhsProfileTarget(input, { fetch } = {}) {
    const text = String(input ?? '').trim();
    const link = findXhsLink(text) ?? text;
    if (!isXhsShortLink(link)) return parseXhsProfileTarget(link);
    const location = await readXhsShortLink(link, { fetch });
    let target = null;
    try {
        if (location) target = parseXhsProfileTarget(location);
    } catch {
        target = null;
    }
    if (target) return target;
    throw new ArgumentError(
        `这条短链接打开的不是博主主页：${link} → ${location || '没有跳转'}`,
        '请在小红书 App 进入博主主页，点「分享 → 复制链接」；笔记的分享链接不能用在这里，短链接失效时重新复制一次即可',
    );
}
