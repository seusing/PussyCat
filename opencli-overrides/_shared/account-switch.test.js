import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, TimeoutError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { registerSiteSwitchCommand, switchAccount } from './account-switch.js';

// 浏览器里的账号:account 为 null 表示未登录;steps[i] 在第 i 次 page.wait 时执行,模拟用户在页面里的操作。
function harness({ account, key = account ? `k-${account}` : '', steps = [], whoamiFailures = 0, logout, withLoginPage = false }) {
    const browser = { account, key, onLoginPage: false };
    let tick = 0;
    let failures = whoamiFailures;
    const page = {
        closeWindow: vi.fn(async () => {}),
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
        ...(logout ? { logout: vi.fn(async () => logout(browser)) } : {}),
        ...(withLoginPage ? { loginInProgress: async () => browser.onLoginPage } : {}),
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
        // 先释放后台会话再跳转,扩展才会新建租约并把窗口调到前台
        expect(page.closeWindow.mock.invocationCallOrder[0]).toBeLessThan(page.goto.mock.invocationCallOrder[0]);
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

    describe('站点提供退出入口时', () => {
        it('先登出再打开登录页,登上另一个号就结束', async () => {
            const { page, options } = harness({ account: 'A', logout, steps: [() => {}, login('B')] });
            const result = await switchAccount(page, 'example', options, { waitSeconds: 5 });
            expect(options.logout).toHaveBeenCalledTimes(1);
            expect(page.goto).toHaveBeenLastCalledWith('https://example.com/login');
            expect(page.goto).not.toHaveBeenCalledWith('https://example.com/');
            expect(result).toMatchObject({ status: 'switched', previous: 'A', username: 'B' });
        });

        it('登出后扫回同一个号也结束,标成 same_account', async () => {
            const { page, options } = harness({ account: 'A', logout, steps: [login('A', 'k-A-again')] });
            await expect(switchAccount(page, 'example', options, { waitSeconds: 5 }))
                .resolves.toMatchObject({ status: 'same_account', previous: 'A', username: 'A' });
        });

        it('退出没生效:改开首页,等到换了人才结束', async () => {
            const { page, options } = harness({ account: 'A', logout: () => {}, steps: [login('A', 'k-A-again'), login('B')] });
            const result = await switchAccount(page, 'example', options, { waitSeconds: 5 });
            expect(page.goto).toHaveBeenLastCalledWith('https://example.com/');
            expect(result).toMatchObject({ status: 'switched', username: 'B' });
        });

        it('退出入口报错也不中断,退回由用户自己退出', async () => {
            const { page, options } = harness({ account: 'A', logout: () => { throw new Error('entry not found'); }, steps: [logout, login('B')] });
            await expect(switchAccount(page, 'example', options, { waitSeconds: 5 }))
                .resolves.toMatchObject({ status: 'switched', username: 'B' });
            expect(page.goto).toHaveBeenLastCalledWith('https://example.com/');
        });

        it('本来没登录:不调退出,直接打开登录页', async () => {
            const { page, options } = harness({ account: null, logout, steps: [login('C')] });
            await switchAccount(page, 'example', options, { waitSeconds: 5 });
            expect(options.logout).not.toHaveBeenCalled();
            expect(page.goto).toHaveBeenCalledWith('https://example.com/login');
        });
    });

    it('还停在登录页时不探测身份(探测会跳页面打断扫码),离开登录页再探', async () => {
        // 扫完第一次码被转到另一个地区的登录页:会话 cookie 变了,但还没登上
        const toSecondLoginPage = (browser) => { browser.key = 'k-guest'; browser.onLoginPage = true; };
        const secondScan = (browser) => { login('B')(browser); browser.onLoginPage = false; };
        const { page, whoami, options } = harness({ account: null, withLoginPage: true, steps: [toSecondLoginPage, () => {}, secondScan] });
        await expect(switchAccount(page, 'example', options, { waitSeconds: 5 }))
            .resolves.toMatchObject({ status: 'switched', username: 'B' });
        // 开头一次 + 离开登录页后一次;停在登录页的两轮都没探测
        expect(whoami).toHaveBeenCalledTimes(2);
    });

    it('退出时拿到换号前的账号,站点据此选退出入口', async () => {
        const { page, options } = harness({ account: 'A', logout, steps: [login('B')] });
        await switchAccount(page, 'example', options, { waitSeconds: 5 });
        expect(options.logout).toHaveBeenCalledWith(page, expect.objectContaining({ username: 'A' }));
    });
});

describe('registerSiteSwitchCommand', () => {
    it('站点自带的身份探测优先于上游 whoami', async () => {
        const { page, options } = harness({ account: null, steps: [login('C')] });
        registerSiteSwitchCommand({ site: 'switch-test', domain: 'example.com', columns: ['username'], ...options });
        const command = getRegistry().get('switch-test/switch-account');
        expect(command.args).toEqual([expect.objectContaining({ name: 'timeout', default: 300 })]);
        await expect(command.func(page, { timeout: 5 })).resolves.toMatchObject({ status: 'switched', username: 'C' });
        expect(options.whoami).toHaveBeenCalled();
    });
});
