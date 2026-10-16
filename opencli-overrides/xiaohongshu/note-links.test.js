import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { expandXhsNoteLink } from './note-helpers.js';
import { isXhsShortLink } from './short-link.js';
import './note.js';
import './comments.js';
import './download.js';

const SHORT_LINK = 'http://xhslink.cn/o/7W0JZAPJ1mX';
const NOTE = 'https://www.xiaohongshu.com/discovery/item/6a6a1379000000001f01c03c?app_platform=ios&app_version=9.40.1&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=CBnCqgaysCKJFwNL9yb6Cq0QvfYcPUnkDPsdCV8n-_eHo=&author_share=1&xhsshare=CopyLink&shareRedId=ODYyMDQ-RTw2NzUyOTgwNjY0OTc1PD0_&apptime=1785396326&share_id=e372d3d616124925863ae18c6d119ab5';
const HOME = 'https://www.xiaohongshu.com';
const PROFILE = 'https://www.xiaohongshu.com/user/profile/63b98bad0000000026010302?xsec_token=T';
const redirectingFetch = (location) => vi.fn(async () => new Response(null, { status: location ? 302 : 200, headers: location ? { location } : {} }));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('isXhsShortLink', () => {
    it('recognises xhslink.cn, xhslink.com and their subdomains in any letter case', () => {
        for (const link of ['http://xhslink.cn/o/AbCd', 'https://xhslink.com/o/AbCd', 'https://www.xhslink.cn/o/AbCd', 'https://XHSLINK.COM/o/AbCd']) {
            expect(isXhsShortLink(link)).toBe(true);
        }
    });

    it('rejects look-alike hosts, other schemes and bare ids', () => {
        for (const input of ['https://evilxhslink.com/x', 'https://example.com/xhslink.cn/o/x', '6a6a1379000000001f01c03c', 'ftp://xhslink.cn/x', '', undefined]) {
            expect(isXhsShortLink(input)).toBe(false);
        }
    });
});

describe('expandXhsNoteLink', () => {
    it('turns an xhslink note short link into the signed note URL with one non-following request', async () => {
        for (const link of [SHORT_LINK, 'https://xhslink.com/o/7jNHVIMi1N3']) {
            const fetch = redirectingFetch(NOTE);
            await expect(expandXhsNoteLink(link, { fetch })).resolves.toBe(NOTE);
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(fetch).toHaveBeenCalledWith(link, expect.objectContaining({ redirect: 'manual' }));
        }
    });

    it('trims whitespace around a short link before requesting it', async () => {
        const fetch = redirectingFetch(NOTE);
        await expect(expandXhsNoteLink(`  ${SHORT_LINK}\n`, { fetch })).resolves.toBe(NOTE);
        expect(fetch.mock.calls[0][0]).toBe(SHORT_LINK);
    });

    it('returns other input untouched without any request', async () => {
        const fetch = redirectingFetch(NOTE);
        for (const input of [NOTE, '6a6a1379000000001f01c03c', `  ${NOTE}  `]) {
            await expect(expandXhsNoteLink(input, { fetch })).resolves.toBe(input);
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('explains in Chinese when the short link does not open a note', async () => {
        for (const fetch of [redirectingFetch(HOME), redirectingFetch(PROFILE), redirectingFetch('')]) {
            const error = await expandXhsNoteLink(SHORT_LINK, { fetch }).catch((caught) => caught);
            expect(error).toBeInstanceOf(ArgumentError);
            expect(error.message).toContain(SHORT_LINK);
            expect(error.message).toContain('笔记');
            expect(error.hint).toContain('分享 → 复制链接');
        }
    });

    it('reports a failed request as a command error naming the short link', async () => {
        const fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
        const error = await expandXhsNoteLink(SHORT_LINK, { fetch }).catch((caught) => caught);
        expect(error).toBeInstanceOf(CommandExecutionError);
        expect(error.message).toContain('短链接');
        expect(error.message).toContain(SHORT_LINK);
        expect(error.message).toContain('fetch failed');
    });
});

describe('xiaohongshu note, comments and download accept short links', () => {
    const SENTINEL = new Error('stop after goto');
    const notePage = () => ({
        goto: vi.fn(),
        wait: vi.fn(),
        evaluate: vi.fn(async () => { throw SENTINEL; }),
    });
    const commands = [
        ['xiaohongshu/note', {}],
        ['xiaohongshu/comments', { limit: 20 }],
        ['xiaohongshu/download', { output: 'unused-download-dir' }],
    ];

    it.each(commands)('%s opens the note the short link points to', async (name, extra) => {
        const fetch = redirectingFetch(NOTE);
        vi.stubGlobal('fetch', fetch);
        const page = notePage();
        await expect(getRegistry().get(name).func(page, { 'note-id': 'https://xhslink.cn/o/7W0JZAPJ1mX', ...extra })).rejects.toBe(SENTINEL);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.goto.mock.calls[0][0]).toBe(NOTE);
    });

    it.each(commands)('%s stops before opening any page when the short link is not a note', async (name, extra) => {
        vi.stubGlobal('fetch', redirectingFetch(HOME));
        const page = notePage();
        await expect(getRegistry().get(name).func(page, { 'note-id': 'https://xhslink.cn/o/invalid', ...extra })).rejects.toBeInstanceOf(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
});
