import { ArgumentError } from '@jackwener/opencli/errors';
import { findXhsLink, isXhsShortLink, readXhsShortLink } from './short-link.js';

/** Side-effect-free helpers shared by xiaohongshu note and comments commands. */
/** Extract a bare note ID from a full URL or raw ID string. */
export function parseNoteId(input) {
    const trimmed = input.trim();
    const match = trimmed.match(/\/(?:explore|note|search_result|discovery\/item)\/([a-f0-9]+)|\/user\/profile\/[^/?#]+\/([a-f0-9]+)/i);
    return match ? (match[1] || match[2]) : trimmed;
}

export const XHS_SIGNED_URL_HINT = 'Pass a full Xiaohongshu note URL with xsec_token from search results or user/profile context.';

function isShortLink(input) {
    return /^https?:\/\/xhslink\.com\//i.test(input);
}

function isHostMatch(hostname, cookieRoot) {
    const normalized = hostname.toLowerCase();
    return normalized === cookieRoot || normalized.endsWith('.' + cookieRoot);
}

function isSupportedNotePath(pathname) {
    return /^\/(?:explore|note|search_result|discovery\/item)\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname)
        || /^\/user\/profile\/[^/?#]+\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname);
}

/**
 * Build the best navigation URL for a note.
 *
 * XHS note detail pages now require a valid signed URL for reliable access.
 * Bare note IDs no longer resolve deterministically, so callers must provide
 * a full note URL with xsec_token or, for downloads only, an xhslink short link.
 *
 * `options.cookieRoot` overrides the default `xiaohongshu.com` cookie root —
 * the rednote adapter passes `'rednote.com'` so the same validator accepts
 * `www.rednote.com` URLs without duplicating this function.
 * `options.signedUrlHint` overrides the default hint surfaced on rejection.
 */
export function buildNoteUrl(input, options = {}) {
    const {
        allowShortLink = false,
        commandName = 'xiaohongshu note',
        cookieRoot = 'xiaohongshu.com',
        signedUrlHint = XHS_SIGNED_URL_HINT,
    } = options;
    const trimmed = input.trim();
    const message = `${commandName} now requires a full signed URL`;
    const hint = allowShortLink
        ? `${signedUrlHint} For downloads, xhslink short links are also supported.`
        : signedUrlHint;

    if (/^https?:\/\//.test(trimmed)) {
        if (isShortLink(trimmed)) {
            if (allowShortLink)
                return trimmed;
            throw new ArgumentError(message, hint);
        }
        try {
            const url = new URL(trimmed);
            const xsecToken = url.searchParams.get('xsec_token')?.trim();
            if (isHostMatch(url.hostname, cookieRoot) && isSupportedNotePath(url.pathname) && xsecToken) {
                return trimmed;
            }
        }
        catch { }
        throw new ArgumentError(message, hint);
    }
    throw new ArgumentError(message, hint);
}

const LINK_HINT = '请在小红书 App 里点「分享 → 复制链接」，或从搜索结果、博主主页复制完整链接';
const NOTE_PATH = /^\/(?:(?:explore|note|search_result|discovery\/item)\/[a-f0-9]+|user\/profile\/[^/?#]+\/[a-f0-9]+)(?:[/?#]|$)/i;

function parseXiaohongshuUrl(link) {
    try {
        const url = new URL(link);
        return /^https?:$/.test(url.protocol) && isHostMatch(url.hostname, 'xiaohongshu.com') ? url : null;
    } catch {
        return null;
    }
}

/**
 * 笔记命令的链接入口：从分享文案或链接里取出小红书链接，一定返回带 xsec_token 的签名笔记链接，否则抛中文 ArgumentError。
 * xhslink 短链接先展开成它跳转到的签名笔记链接；完整链接交给 buildNoteUrl 校验；裸笔记 ID 已经打不开。
 */
export async function resolveXhsNoteLink(input, { fetch } = {}) {
    const text = String(input);
    const link = findXhsLink(text) ?? text.trim();
    if (isXhsShortLink(link)) {
        const location = await readXhsShortLink(link, { fetch });
        try {
            if (location) return buildNoteUrl(location);
        } catch {
            // 跳到了首页、博主主页等非笔记页，下面统一报中文错误。
        }
        throw new ArgumentError(
            `这条短链接打开的不是笔记：${link} → ${location || '没有跳转'}`,
            '请在小红书 App 打开笔记，点「分享 → 复制链接」；博主主页的短链接请用「博主全部笔记」，短链接失效时重新复制一次即可',
        );
    }
    const url = parseXiaohongshuUrl(link);
    if (url) {
        try {
            return buildNoteUrl(link);
        } catch {
            // 下面区分是缺 xsec_token 还是根本不是笔记链接。
        }
        throw new ArgumentError(
            NOTE_PATH.test(url.pathname)
                ? `这条笔记链接缺少 xsec_token，小红书只认带签名的链接：${link}`
                : `这不是小红书笔记链接：${link}`,
            LINK_HINT,
        );
    }
    throw new ArgumentError(
        '请填写小红书笔记链接',
        '支持 App「分享 → 复制链接」得到的短链接（或整段分享文案），以及带 xsec_token 的完整笔记链接；单独的笔记 ID 已经打不开',
    );
}
