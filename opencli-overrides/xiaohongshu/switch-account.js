import './auth.js';
import { registerSiteSwitchCommand } from '../_shared/account-switch.js';
import { XHS_REGIONS, xhsIdToken } from './region.js';

// 在网页版登录页扫码:扫码的账号属于另一个地区时,网页版会带着这次扫码的 qrId、code 转到那个地区的网页版,
// 由那边接着登录,只扫一次。创作者中心的登录页转过去时会丢掉这次扫码,要再扫一次,所以不在那里登录。
// 两个地区的创作者中心和网页版共用同一个 web_session,网页版登上后创作者中心也是登录态。
const LOGIN_URL = `https://${XHS_REGIONS[0].webHost}/login`;

export const switchOptions = {
    site: 'xiaohongshu',
    domain: 'creator.xiaohongshu.com',
    columns: ['username', 'followers', 'region'],
    // 退出不了时打开大陆版创作者中心首页,由用户自己退出
    homeUrl: `${XHS_REGIONS[0].creatorOrigin}/`,
    loginUrl: LOGIN_URL,
    // 两个地区的 id_token 拼起来:任一边真正登录、退出时才变,打开登录页拿到游客会话不算。
    // 另一个地区接着登录后页面可能还停在登录页、登录框也还在,所以不看页面,只看它。
    accountKey: async (page) => {
        const tokens = [];
        for (const region of XHS_REGIONS) tokens.push(await xhsIdToken(page, region));
        return tokens.some(Boolean) ? tokens.join('|') : '';
    },
    identify: (identity) => `${identity.region}:${identity.username}`,
    // 在当前账号所在地区的创作者中心:右上角头像菜单「退出登录」,再在确认框点「确定」;退出后跳到扫码登录页
    logout: async (page, before) => {
        const { creatorOrigin } = XHS_REGIONS.find(({ region }) => region === before?.region) ?? XHS_REGIONS[0];
        await page.goto(`${creatorOrigin}/new/home`);
        await page.evaluate(`(async () => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const find = (root, selector, text) => [...root.querySelectorAll(selector)].find((el) => el.textContent.trim() === text);
            let item;
            for (let i = 0; i < 20 && !item; i += 1) {
                item = find(document, '.menu-list *', '退出登录');
                if (!item) await sleep(500);
            }
            if (!item) throw new Error('logout menu item not found');
            item.click();
            for (let i = 0; i < 20; i += 1) {
                const dialog = [...document.querySelectorAll('[class*=modal], [class*=dialog]')].find((el) => el.innerText.includes('退出登录'));
                const confirm = dialog && find(dialog, 'button', '确定');
                if (confirm) {
                    confirm.click();
                    return true;
                }
                await sleep(300);
            }
            throw new Error('logout confirmation not found');
        })()`);
        await page.wait(3);
    },
};

registerSiteSwitchCommand(switchOptions);
