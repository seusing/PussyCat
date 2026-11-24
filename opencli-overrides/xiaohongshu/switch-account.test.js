import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { switchAccount } from '../_shared/account-switch.js';
import { switchOptions } from './switch-account.js';

// auth.js 引用的 _shared/site-auth.js 只在 OpenCLI 包里有
vi.mock('./auth.js', () => ({}));

// cookies 按 cookieRoot 存两个地区的 cookie;steps[i] 在第 i 次 page.wait 时执行,模拟页面和用户的操作
function fakePage(cookies, steps = []) {
    let tick = 0;
    return {
        getCookies: async ({ url }) => {
            const root = new URL(url).hostname.split('.').slice(-2).join('.');
            return Object.entries(cookies[root] ?? {}).map(([name, value]) => ({ name, value }));
        },
        closeWindow: async () => {},
        goto: vi.fn(async () => {}),
        wait: async () => {
            steps[tick]?.(cookies);
            tick += 1;
        },
    };
}

describe('xiaohongshu switch-account', () => {
    it('logs in on the main site, which hands a scan from the other region over without a second scan', () => {
        expect(switchOptions.loginUrl).toBe('https://www.xiaohongshu.com/login');
    });

    it('keys the session on id_token, so the guest session a login page hands out does not count', async () => {
        const cookies = { 'xiaohongshu.com': { web_session: 'guest', id_token: '' } };
        expect(await switchOptions.accountKey(fakePage(cookies))).toBe('');
        cookies['rednote.com'] = { web_session: 'user', id_token: 'token' };
        expect(await switchOptions.accountKey(fakePage(cookies))).toBe('|token');
    });

    it('finishes once the other region is signed in, even though that page still shows the login box', async () => {
        const cookies = {};
        const openLoginPage = (state) => { state['xiaohongshu.com'] = { web_session: 'guest', id_token: '' }; };
        const scanOnce = (state) => { state['rednote.com'] = { web_session: 'user', id_token: 'token' }; };
        const whoami = vi.fn(async () => {
            if (!cookies['rednote.com']?.id_token) throw new AuthRequiredError('creator.xiaohongshu.com');
            return { username: 'Lauseusing', followers: 27, region: 'rednote' };
        });
        const page = fakePage(cookies, [openLoginPage, scanOnce]);
        await expect(switchAccount(page, 'xiaohongshu', { ...switchOptions, whoami }, { waitSeconds: 5 }))
            .resolves.toMatchObject({ status: 'switched', username: 'Lauseusing', region: 'rednote' });
        expect(page.goto).toHaveBeenCalledWith('https://www.xiaohongshu.com/login');
        // 开头一次 + 登上后一次:游客会话出现时没有去探测(探测会跳走页面,打断扫码)
        expect(whoami).toHaveBeenCalledTimes(2);
    });
});
