import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, TimeoutError } from '@jackwener/opencli/errors';
import { switchAccount } from './account-switch.js';

// 浏览器里的账号:account 为 null 表示未登录;steps[i] 在第 i 次 page.wait 时执行,模拟用户在页面里的操作。
function harness({ account, key = account ? `k-${account}` : '', steps = [], whoamiFailures = 0 }) {
    const browser = { account, key };
    let tick = 0;
    let failures = whoamiFailures;
    const page = {
        goto: vi.fn(async () => {}),
        wait: vi.fn(async () => {
            steps[tick]?.(browser);
            tick += 1;
            await new Promise((resolve) => setTimeout(resolve, 1));
        }),
    };
    const whoami = vi.fn(async () => {
        if (tick > 0 && failures > 0) {
            failures -= 1;
            throw new Error('page is navigating');
        }
        if (!browser.account) throw new AuthRequiredError('example.com');
        return { logged_in: true, site: 'example', username: browser.account };
    });
    const options = {
        whoami,
        accountKey: async () => browser.key,
        identify: (identity) => identity.username,
        homeUrl: 'https://example.com/',
        loginUrl: 'https://example.com/login',
    };
    return { page, whoami, options };
}

const logout = (browser) => { browser.account = null; browser.key = ''; };
const login = (name, key = `k-${name}`) => (browser) => { browser.account = name; browser.key = key; };

describe('switchAccount', () => {
    it('已登录:打开首页,用户退出再登另一个号,报告换号前后', async () => {
        const { page, whoami, options } = harness({ account: 'A', steps: [() => {}, logout, () => {}, login('B')] });
        const result = await switchAccount(page, 'example', options, { waitSeconds: 5 });
        expect(page.goto).toHaveBeenCalledWith('https://example.com/');
        expect(result).toMatchObject({ status: 'switched', previous: 'A', username: 'B' });
        // 会话指纹没变时不探测身份:开头一次 + 换号后一次
        expect(whoami).toHaveBeenCalledTimes(2);
    });

    it('重新登录同一个号不算换号,继续等', async () => {
        const { page, options } = harness({ account: 'A', steps: [logout, login('A', 'k-A-again'), login('B')] });
        await expect(switchAccount(page, 'example', options, { waitSeconds: 5 }))
            .resolves.toMatchObject({ previous: 'A', username: 'B' });
        expect(page.wait).toHaveBeenCalledTimes(3);
    });

    it('未登录:直接打开登录页,登上任意账号就结束', async () => {
        const { page, options } = harness({ account: null, steps: [login('C')] });
        const result = await switchAccount(page, 'example', options, { waitSeconds: 5 });
        expect(page.goto).toHaveBeenCalledWith('https://example.com/login');
        expect(result).toMatchObject({ status: 'switched', previous: '', username: 'C' });
    });

    it('换号后身份探测临时失败,下一轮重探', async () => {
        const { page, whoami, options } = harness({ account: 'A', steps: [login('B')], whoamiFailures: 1 });
        await expect(switchAccount(page, 'example', options, { waitSeconds: 5 }))
            .resolves.toMatchObject({ username: 'B' });
        expect(whoami).toHaveBeenCalledTimes(3);
    });

    it('一直没换号:到时限报超时', async () => {
        const { page, options } = harness({ account: 'A' });
        await expect(switchAccount(page, 'example', options, { waitSeconds: 0.05 })).rejects.toBeInstanceOf(TimeoutError);
    });
});
