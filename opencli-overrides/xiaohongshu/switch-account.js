import './auth.js';
import { registerSiteSwitchCommand } from '../_shared/account-switch.js';

// 创作者中心:未登录时就是登录页,已登录时右上角头像菜单里能退出。
const CREATOR_URL = 'https://creator.xiaohongshu.com/';

registerSiteSwitchCommand({
    site: 'xiaohongshu',
    domain: 'creator.xiaohongshu.com',
    columns: ['username', 'followers'],
    homeUrl: CREATOR_URL,
    loginUrl: CREATOR_URL,
    // web_session 换号就换值,但不带用户信息,是不是同一个人看昵称
    accountKey: async (page) => {
        const cookies = await page.getCookies({ url: CREATOR_URL });
        return cookies.find((cookie) => cookie.name === 'web_session')?.value ?? '';
    },
    identify: (identity) => identity.username,
});
