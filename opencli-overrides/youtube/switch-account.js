import './auth.js';
import { registerSiteSwitchCommand } from '../_shared/account-switch.js';

const YOUTUBE_URL = 'https://www.youtube.com/';

registerSiteSwitchCommand({
    site: 'youtube',
    domain: 'www.youtube.com',
    columns: ['name'],
    // 不退出:YouTube 用的是 Google 账号,退出会连 Gmail 等一起登出。改为打开「添加另一个 Google 账号」,
    // 登好后回到 YouTube;已有多个账号的也可以在头像菜单里直接切换。
    homeUrl: `https://accounts.google.com/AddSession?service=youtube&continue=${encodeURIComponent(YOUTUBE_URL)}`,
    loginUrl: `https://accounts.google.com/ServiceLogin?service=youtube&continue=${encodeURIComponent(YOUTUBE_URL)}`,
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
