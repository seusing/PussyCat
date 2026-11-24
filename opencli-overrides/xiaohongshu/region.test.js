import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { regionOfHost, resolveXhsRegion, whoamiOnCreator, withXhsHost } from './region.js';

const SIGNED_IN = [{ name: 'web_session', value: 's' }, { name: 'id_token', value: 'token' }];
const GUEST = [{ name: 'web_session', value: 's' }, { name: 'id_token', value: '' }];

function cookiePage(cookies) {
    return { getCookies: vi.fn(async ({ url }) => cookies[new URL(url).hostname] ?? []) };
}

describe('xiaohongshu regions', () => {
    it('maps hosts of both regions, subdomains included', () => {
        expect(regionOfHost('www.xiaohongshu.com')?.region).toBe('xiaohongshu');
        expect(regionOfHost('creator.rednote.com')?.region).toBe('rednote');
        expect(regionOfHost('rednote.com.evil.com')).toBeNull();
        expect(regionOfHost('xhslink.cn')).toBeNull();
    });

    it('swaps the host of a note link and keeps the signed query', () => {
        const link = 'https://www.rednote.com/discovery/item/6a6a1379000000001f01c03c?xsec_token=AB=&xsec_source=pc_search';
        expect(withXhsHost(link, 'www.xiaohongshu.com'))
            .toBe('https://www.xiaohongshu.com/discovery/item/6a6a1379000000001f01c03c?xsec_token=AB=&xsec_source=pc_search');
        expect(withXhsHost(link, 'www.rednote.com')).toBe(link);
        expect(withXhsHost('https://example.com/explore/1', 'www.rednote.com')).toBe('https://example.com/explore/1');
    });

    it('uses the international site only when it is signed in and the mainland one is not', async () => {
        const region = async (cookies) => (await resolveXhsRegion(cookiePage(cookies))).webHost;
        expect(await region({})).toBe('www.xiaohongshu.com');
        expect(await region({ 'www.xiaohongshu.com': GUEST, 'www.rednote.com': GUEST })).toBe('www.xiaohongshu.com');
        expect(await region({ 'www.xiaohongshu.com': SIGNED_IN, 'www.rednote.com': SIGNED_IN })).toBe('www.xiaohongshu.com');
        expect(await region({ 'www.xiaohongshu.com': GUEST, 'www.rednote.com': SIGNED_IN })).toBe('www.rednote.com');
    });
});

// 创作者中心页面:goto 改 origin,personal_info 按 origin 返回 [ok, status, name, followers]
function creatorPage({ origin = 'about:blank', cookies = {}, profiles = {} }) {
    let current = origin;
    return {
        ...cookiePage(cookies),
        goto: vi.fn(async (url) => { current = new URL(url).origin; }),
        evaluate: vi.fn(async (script) => (script === 'location.origin' ? current
            : profiles[current] ?? [false, 401, '', 0])),
    };
}

describe('whoamiOnCreator', () => {
    it('finds an international account and says so', async () => {
        const page = creatorPage({ profiles: { 'https://creator.rednote.com': [true, 200, '小林', 3] } });
        await expect(whoamiOnCreator(page)).resolves.toEqual({ username: '小林', followers: 3, region: 'rednote' });
        expect(page.goto.mock.calls.map(([url]) => url)).toEqual(['https://creator.xiaohongshu.com/new/home', 'https://creator.rednote.com/new/home']);
    });

    it('checks the region the cookies point at first', async () => {
        const page = creatorPage({
            cookies: { 'www.rednote.com': SIGNED_IN },
            profiles: { 'https://creator.rednote.com': [true, 200, '小林', 3] },
        });
        await expect(whoamiOnCreator(page)).resolves.toMatchObject({ region: 'rednote' });
        expect(page.goto.mock.calls.map(([url]) => url)).toEqual(['https://creator.rednote.com/new/home']);
    });

    it('stays on the creator center it is already on', async () => {
        const page = creatorPage({ origin: 'https://creator.xiaohongshu.com', profiles: { 'https://creator.xiaohongshu.com': [true, 200, '大陆号', 0] } });
        await expect(whoamiOnCreator(page)).resolves.toEqual({ username: '大陆号', followers: 0, region: 'xiaohongshu' });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('reports logged out when neither region is signed in, or one cannot be opened', async () => {
        await expect(whoamiOnCreator(creatorPage({}))).rejects.toBeInstanceOf(AuthRequiredError);
        const page = creatorPage({});
        page.goto.mockImplementation(async (url) => { if (url.includes('rednote')) throw new Error('net::ERR_CONNECTION_CLOSED'); });
        await expect(whoamiOnCreator(page)).rejects.toBeInstanceOf(AuthRequiredError);
    });
});
