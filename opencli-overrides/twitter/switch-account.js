import './auth.js';
import { registerSiteSwitchCommand } from '../_shared/account-switch.js';

registerSiteSwitchCommand({
    site: 'twitter',
    domain: 'x.com',
    columns: ['username', 'url'],
    // 已登录时首页左下角的账号菜单可以退出或切到另一个已添加的账号
    homeUrl: 'https://x.com/home',
    loginUrl: 'https://x.com/i/flow/login',
    // twid 形如 u%3D<用户 id>,换号即变;auth_token 不在就是没登录
    accountKey: async (page) => {
        const cookies = await page.getCookies({ url: 'https://x.com' });
        const value = (name) => cookies.find((cookie) => cookie.name === name)?.value ?? '';
        return value('auth_token') ? value('twid') : '';
    },
    identify: (identity) => identity.username,
});
