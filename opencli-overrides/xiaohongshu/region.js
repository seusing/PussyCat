import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

// 小红书分大陆版(xiaohongshu.com)和国际版(rednote.com):网页版和创作者中心是同一套前端,
// 笔记链接里的 xsec_token 两边通用。用海外手机号注册的账号只能登上国际版,登录态在 .rednote.com 上,
// xiaohongshu.com 这边仍是游客。命令在账号所在地区的网页版里打开页面,输出的链接一律写成 www.xiaohongshu.com。
export const XHS_REGIONS = [
    { region: 'xiaohongshu', cookieRoot: 'xiaohongshu.com', webHost: 'www.xiaohongshu.com', creatorOrigin: 'https://creator.xiaohongshu.com' },
    { region: 'rednote', cookieRoot: 'rednote.com', webHost: 'www.rednote.com', creatorOrigin: 'https://creator.rednote.com' },
];
const [MAINLAND, INTERNATIONAL] = XHS_REGIONS;

/** 主机名(含子域)属于哪个地区;都不是返回 null。 */
export function regionOfHost(hostname) {
    const host = String(hostname ?? '').toLowerCase();
    return XHS_REGIONS.find(({ cookieRoot }) => host === cookieRoot || host.endsWith(`.${cookieRoot}`)) ?? null;
}

/** 把两个地区的链接换成指定网页版主机,路径和参数(含 xsec_token)不变;别的链接原样返回。 */
export function withXhsHost(link, webHost) {
    const url = new URL(link);
    if (url.hostname === webHost || !regionOfHost(url.hostname)) return link;
    url.hostname = webHost;
    return url.toString();
}

/**
 * 该地区的 id_token:只在登录时发、退出时清空,游客和退出登录后是空串。
 * web_session 不能这么用,游客一打开页面就会拿到一个。
 */
export async function xhsIdToken(page, { webHost }) {
    const cookies = await page.getCookies({ url: `https://${webHost}/` });
    return cookies.find((cookie) => cookie.name === 'id_token')?.value ?? '';
}

/** 命令该在哪个地区的网页版里打开页面:大陆版没登录、国际版登录了才用国际版。 */
export async function resolveXhsRegion(page) {
    if (await xhsIdToken(page, MAINLAND)) return MAINLAND;
    return await xhsIdToken(page, INTERNATIONAL) ? INTERNATIONAL : MAINLAND;
}

// 在当前页面(须已在该地区的创作者中心)请求创作者资料;上游 xiaohongshu whoami 用的也是这个接口
async function personalInfoHere(page) {
    const [ok, status, name, followers] = await page.evaluate(`(async () => {
        try {
            const response = await fetch('/api/galaxy/creator/home/personal_info', { credentials: 'include' });
            const body = await response.json().catch(() => null);
            return [response.ok && !!body?.data, response.status, body?.data?.name ?? '', body?.data?.fans_count ?? 0];
        } catch (error) {
            return [false, 0, '', 0];
        }
    })()`);
    if (status === 401 || status === 403) return null;
    if (!ok) throw new CommandExecutionError(`Xiaohongshu creator profile failed (HTTP ${status || 'unknown'})`);
    return { username: String(name), followers: Number(followers) || 0 };
}

const currentOrigin = (page) => page.evaluate('location.origin').catch(() => '');

/**
 * 在创作者中心查当前登录的账号和所在地区。先查当前页面所在的创作者中心(不跳页面),
 * 再按 cookie 判断的地区、其余地区的顺序跳过去查。
 */
export async function whoamiOnCreator(page) {
    const here = await currentOrigin(page);
    const preferred = await resolveXhsRegion(page);
    const rank = (item) => (item.creatorOrigin === here ? 2 : item === preferred ? 1 : 0);
    for (const item of [...XHS_REGIONS].sort((a, b) => rank(b) - rank(a))) {
        if (item.creatorOrigin !== here) {
            try {
                await page.goto(`${item.creatorOrigin}/new/home`);
            }
            catch {
                continue; // 打不开(例如代理连不上 rednote.com)就当这边没登录
            }
        }
        if (await currentOrigin(page) !== item.creatorOrigin) continue;
        const info = await personalInfoHere(page);
        if (info) return { ...info, region: item.region };
    }
    throw new AuthRequiredError('creator.xiaohongshu.com', 'Not logged into the Xiaohongshu creator center');
}
