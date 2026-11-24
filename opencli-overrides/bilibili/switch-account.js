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
    // 网页「退出登录」调的接口:POST passport /login/exit/v2,biliCSRF 取页面上的 bili_jct
    logout: async (page) => {
        await page.goto('https://www.bilibili.com/');
        await page.evaluate(`(async () => {
            const csrf = (document.cookie.match(/(?:^|; )bili_jct=([^;]+)/) || [])[1];
            if (!csrf) throw new Error('bili_jct missing');
            const response = await fetch('https://passport.bilibili.com/login/exit/v2', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'biliCSRF=' + csrf,
            });
            return response.status;
        })()`);
    },
});
