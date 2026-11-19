import './auth.js';
import { registerSiteSwitchCommand } from '../_shared/account-switch.js';

registerSiteSwitchCommand({
    site: 'youtube',
    domain: 'www.youtube.com',
    columns: ['name'],
    // 已登录时头像菜单里有「切换账号」和「退出」
    homeUrl: 'https://www.youtube.com/',
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
    // 同一组 Google 登录 cookie 下可以切账号或频道,cookie 不变;只能读页面上的 DATASYNC_ID。
    // 只在 YouTube 页面上读,停在 accounts.google.com 时返回 '',不打断登录。
    accountKey: async (page) => page.evaluate(`
        (() => {
            if (location.hostname !== 'www.youtube.com') return '';
            const cfg = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg : null;
            if (!cfg || cfg.get('LOGGED_IN') !== true) return '';
            return String(cfg.get('DATASYNC_ID') || cfg.get('DELEGATED_SESSION_ID') || 'logged-in');
        })()
    `),
    // whoami 的 name 常为空,只能用页面指纹区分
    identify: (identity, key) => key,
});
