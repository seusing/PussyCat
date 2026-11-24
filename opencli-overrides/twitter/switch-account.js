import './auth.js';
import { registerSiteSwitchCommand } from '../_shared/account-switch.js';

registerSiteSwitchCommand({
    site: 'twitter',
    domain: 'x.com',
    columns: ['username', 'url'],
    homeUrl: 'https://x.com/home',
    loginUrl: 'https://x.com/i/flow/login',
    // twid 形如 u%3D<用户 id>,换号即变;auth_token 不在就是没登录
    accountKey: async (page) => {
        const cookies = await page.getCookies({ url: 'https://x.com' });
        const value = (name) => cookies.find((cookie) => cookie.name === name)?.value ?? '';
        return value('auth_token') ? value('twid') : '';
    },
    identify: (identity) => identity.username,
    // 网页的退出页:x.com/logout 弹出确认框,点「退出」
    logout: async (page) => {
        await page.goto('https://x.com/logout');
        await page.evaluate(`(async () => {
            for (let i = 0; i < 20; i += 1) {
                const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
                if (confirm) {
                    confirm.click();
                    return true;
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            throw new Error('logout confirmation not found');
        })()`);
        await page.wait(3);
    },
});
