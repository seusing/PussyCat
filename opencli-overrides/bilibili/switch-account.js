import './auth.js';
import { registerSiteSwitchCommand } from '../_shared/account-switch.js';

registerSiteSwitchCommand({
    site: 'bilibili',
    domain: 'www.bilibili.com',
    columns: ['id', 'username', 'level'],
    homeUrl: 'https://www.bilibili.com/',
    loginUrl: 'https://passport.bilibili.com/login',
    // DedeUserID 就是当前登录的 uid,只有 SESSDATA 也在才算登录着
    accountKey: async (page) => {
        const cookies = await page.getCookies({ url: 'https://www.bilibili.com' });
        const value = (name) => cookies.find((cookie) => cookie.name === name)?.value ?? '';
        return value('SESSDATA') ? value('DedeUserID') : '';
    },
    identify: (identity, key) => String(identity.id || key),
});
