import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { resolveXhsNoteLink } from './note-helpers.js';
import { findXhsLink, isXhsShortLink } from './short-link.js';

const SHORT_LINK = 'http://xhslink.cn/o/7W0JZAPJ1mX';
const NOTE = 'https://www.xiaohongshu.com/discovery/item/6a6a1379000000001f01c03c?app_platform=ios&app_version=9.40.1&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBnCqgaysCKJFwNL9yb6Cq0QvfYcPUnkDPsdCV8n-_eHo=&author_share=1&xhsshare=CopyLink&shareRedId=ODYyMDQ-RTw2NzUyOTgwNjY0OTc1PD0_&apptime=1785396326&share_id=e372d3d616124925863ae18c6d119ab5';
const NOTE_ID = '6a6a1379000000001f01c03c';
const HOME = 'https://www.xiaohongshu.com';
const PROFILE = 'https://www.xiaohongshu.com/user/profile/63b98bad0000000026010302?xsec_token=T';
const SHARE_TEXT = `【测试】 ${SHORT_LINK} 复制后打开【小红书】查看笔记！`;
const redirectingFetch = (location) => vi.fn(async () => new Response(null, { status: location ? 302 : 200, headers: location ? { location } : {} }));

describe('isXhsShortLink', () => {
    it('recognises xhslink.cn, xhslink.com and their subdomains in any letter case', () => {
        for (const link of ['http://xhslink.cn/o/AbCd', 'https://xhslink.com/o/AbCd', 'https://www.xhslink.cn/o/AbCd', 'https://XHSLINK.COM/o/AbCd']) {
            expect(isXhsShortLink(link)).toBe(true);
        }
    });

    it('rejects look-alike hosts, other schemes and bare ids', () => {
        for (const input of ['https://evilxhslink.com/x', 'https://example.com/xhslink.cn/o/x', NOTE_ID, 'ftp://xhslink.cn/x', '', undefined]) {
            expect(isXhsShortLink(input)).toBe(false);
        }
    });
});

describe('findXhsLink', () => {
    it('picks the link out of a whole share text', () => {
        expect(findXhsLink(SHARE_TEXT)).toBe(SHORT_LINK);
        expect(findXhsLink(`我发现一条笔记 ${NOTE} 复制本条信息打开App`)).toBe(NOTE);
    });

    it('stops at Chinese text and drops trailing punctuation', () => {
        expect(findXhsLink('【标题】… https://xhslink.cn/o/7W0JZAPJ1mX，复制后打开【小红书】')).toBe('https://xhslink.cn/o/7W0JZAPJ1mX');
        expect(findXhsLink('https://xhslink.cn/o/7W0JZAPJ1mX复制后打开')).toBe('https://xhslink.cn/o/7W0JZAPJ1mX');
        for (const tail of ['.', ',', ';', ':', '!', '?', ')', '"', "'", ']', '。', '！']) {
            expect(findXhsLink(`看这个(${SHORT_LINK}${tail}`)).toBe(SHORT_LINK);
        }
    });

    it('returns the first Xiaohongshu link and skips other sites', () => {
        expect(findXhsLink(`https://example.com/a ${SHORT_LINK} ${NOTE}`)).toBe(SHORT_LINK);
        expect(findXhsLink(`${PROFILE} ${SHORT_LINK}`)).toBe(PROFILE);
        expect(findXhsLink('https://sub.xhslink.com/o/AbCd https://www.xhslink.cn/o/EfGh')).toBe('https://sub.xhslink.com/o/AbCd');
    });

    it('returns null when there is no Xiaohongshu http link', () => {
        for (const text of ['', NOTE_ID, '无关文本', 'https://example.com/xhslink.cn/o/x', 'https://evilxhslink.com/x', 'https://xiaohongshu.com.evil.com/explore/x', 'ftp://xhslink.cn/x', 'xhslink.cn/o/AbCd']) {
            expect(findXhsLink(text)).toBeNull();
        }
    });
});

describe('resolveXhsNoteLink', () => {
    it('turns an xhslink note short link into the signed note URL with one non-following request', async () => {
        for (const link of [SHORT_LINK, 'https://xhslink.com/o/7jNHVIMi1N3']) {
            const fetch = redirectingFetch(NOTE);
            await expect(resolveXhsNoteLink(link, { fetch })).resolves.toBe(NOTE);
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(fetch).toHaveBeenCalledWith(link, expect.objectContaining({ redirect: 'manual' }));
        }
    });

    it('trims whitespace around a short link before requesting it', async () => {
        const fetch = redirectingFetch(NOTE);
        await expect(resolveXhsNoteLink(`  ${SHORT_LINK}\n`, { fetch })).resolves.toBe(NOTE);
        expect(fetch.mock.calls[0][0]).toBe(SHORT_LINK);
    });

    it('takes the short link out of a whole share text', async () => {
        for (const [text, link] of [
            [SHARE_TEXT, SHORT_LINK],
            ['【标题】… https://xhslink.cn/o/7W0JZAPJ1mX，复制后打开【小红书】查看笔记！', 'https://xhslink.cn/o/7W0JZAPJ1mX'],
        ]) {
            const fetch = redirectingFetch(NOTE);
            await expect(resolveXhsNoteLink(text, { fetch })).resolves.toBe(NOTE);
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(fetch.mock.calls[0][0]).toBe(link);
        }
    });

    it('returns a signed note link as it is, from a bare link or a share text, without any request', async () => {
        const fetch = redirectingFetch(NOTE);
        const explore = 'https://www.xiaohongshu.com/explore/6a6a1379000000001f01c03c?xsec_token=T&xsec_source=pc_search';
        const profileNote = 'https://www.xiaohongshu.com/user/profile/63b98bad0000000026010302/6a6a1379000000001f01c03c?xsec_token=T';
        for (const [input, expected] of [
            [NOTE, NOTE],
            [`  ${NOTE}  `, NOTE],
            [`【测试】 ${NOTE} 复制后打开【小红书】查看笔记！`, NOTE],
            [explore, explore],
            [profileNote, profileNote],
        ]) {
            await expect(resolveXhsNoteLink(input, { fetch })).resolves.toBe(expected);
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('asks for the signed link when a note link has no xsec_token', async () => {
        const fetch = redirectingFetch(NOTE);
        for (const link of [
            `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
            `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}?app_platform=ios`,
            `https://www.xiaohongshu.com/search_result/${NOTE_ID}?xsec_token=&xsec_source=pc_search`,
            `https://www.xiaohongshu.com/user/profile/63b98bad0000000026010302/${NOTE_ID}`,
        ]) {
            for (const input of [link, `【测试】 ${link} 复制后打开【小红书】`]) {
                const error = await resolveXhsNoteLink(input, { fetch }).catch((caught) => caught);
                expect(error).toBeInstanceOf(ArgumentError);
                expect(error.message).toBe(`这条笔记链接缺少 xsec_token，小红书只认带签名的链接：${link}`);
                expect(error.hint).toBe('请在小红书 App 里点「分享 → 复制链接」，或从搜索结果、博主主页复制完整链接');
            }
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('says a Xiaohongshu link is not a note link when the path is not a note', async () => {
        const fetch = redirectingFetch(NOTE);
        for (const link of [PROFILE, HOME, 'https://www.xiaohongshu.com/explore']) {
            const error = await resolveXhsNoteLink(`来看看 ${link} 复制打开`, { fetch }).catch((caught) => caught);
            expect(error).toBeInstanceOf(ArgumentError);
            expect(error.message).toBe(`这不是小红书笔记链接：${link}`);
            expect(error.hint).toBe('请在小红书 App 里点「分享 → 复制链接」，或从搜索结果、博主主页复制完整链接');
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('asks for a note link when the input has none: bare note id, unrelated text, other sites', async () => {
        const fetch = redirectingFetch(NOTE);
        for (const input of [NOTE_ID, '无关文本', '', `https://example.com/explore/${NOTE_ID}?xsec_token=T`, 'https://evilxhslink.com/o/AbCd', 'ftp://xhslink.cn/o/AbCd']) {
            const error = await resolveXhsNoteLink(input, { fetch }).catch((caught) => caught);
            expect(error).toBeInstanceOf(ArgumentError);
            expect(error.message).toBe('请填写小红书笔记链接');
            expect(error.hint).toBe('支持 App「分享 → 复制链接」得到的短链接（或整段分享文案），以及带 xsec_token 的完整笔记链接；单独的笔记 ID 已经打不开');
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('explains in Chinese when the short link does not open a note', async () => {
        for (const fetch of [redirectingFetch(HOME), redirectingFetch(PROFILE), redirectingFetch(`https://www.xiaohongshu.com/explore/${NOTE_ID}`), redirectingFetch('')]) {
            const error = await resolveXhsNoteLink(SHARE_TEXT, { fetch }).catch((caught) => caught);
            expect(error).toBeInstanceOf(ArgumentError);
            expect(error.message).toContain(SHORT_LINK);
            expect(error.message).toContain('笔记');
            expect(error.hint).toContain('分享 → 复制链接');
        }
    });

    it('reports a failed request as a command error naming the short link', async () => {
        const fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
        const error = await resolveXhsNoteLink(SHORT_LINK, { fetch }).catch((caught) => caught);
        expect(error).toBeInstanceOf(CommandExecutionError);
        expect(error.message).toContain('短链接');
        expect(error.message).toContain(SHORT_LINK);
        expect(error.message).toContain('fetch failed');
    });
});
