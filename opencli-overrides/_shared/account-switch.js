import { AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, getRegistry, Strategy } from '@jackwener/opencli/registry';

// 爪爪原生:切换账号。上游 login 已登录时直接返回,换不了号。这里先记下当前账号,用站点自己的退出把它登出,
// 在前台打开登录页(扫码或输密码),等登上账号再结束。浏览器扩展没有删 cookie 的能力,退出只能走站点自己的入口。
export const WAIT_SECONDS = 300;
const POLL_SECONDS = 2;
// 宿主给这条命令的预算是 330s(policy-metadata.mjs),等待上限不能超过 300s
export const TIMEOUT_ARG = { name: 'timeout', type: 'int', default: WAIT_SECONDS, help: 'Seconds to wait for the new login (max 300)' };

function waitSecondsOf(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, WAIT_SECONDS) : WAIT_SECONDS;
}

function displayName(identity) {
    return String(identity?.username || identity?.name || identity?.id || '');
}

/**
 * 换号流程本身,与站点无关。site 文件提供:
 * - whoami(page)(可选):身份探测,未登录抛 AuthRequiredError;不给就复用上游 whoami;
 * - accountKey(page):不跳转的会话指纹,未登录或看不出时返回 '';它一变才去探测身份;
 * - identify(identity, key):判断「是不是同一个人」用的标识;
 * - loginInProgress(page)(可选):页面还停在登录页时返回 true,这一轮不探测身份(探测会跳页面,打断扫码);
 * - logout(page, before)(可选):用站点自己的退出入口登出当前账号 before;
 * - homeUrl / loginUrl:退出成功或本来没登录时打开登录页;退出不了时打开首页,由用户自己退出。
 *
 * 登出成功后登上任何账号都结束(同一个号记为 same_account);没能登出时要等到换了人才结束。
 */
export async function switchAccount(page, site, { whoami, accountKey, identify, loginInProgress, logout, homeUrl, loginUrl }, { waitSeconds = WAIT_SECONDS } = {}) {
    // 从命令开始算:opencli 按 timeout 参数给整条命令计时,退出、打开页面也在这段时间里
    const deadline = Date.now() + waitSeconds * 1000;
    const probe = async () => {
        try {
            return await whoami(page);
        }
        catch (error) {
            if (error instanceof AuthRequiredError) return null;
            throw error;
        }
    };
    const readKey = async () => {
        try {
            return String(await accountKey(page) || '');
        }
        catch {
            return '';
        }
    };

    const before = await probe();
    const beforeKey = await readKey();
    const beforeId = before ? identify(before, beforeKey) : null;
    // 扩展只在新建标签租约时把窗口调到前台;沿用 whoami 留下的后台标签,窗口会一直待在后面(或最小化)。
    // 先释放该站会话,下一次跳转就新建租约,按本命令的 foreground 把窗口拉到前面。
    await page.closeWindow();
    let loggedOut = !before;
    if (before && logout) {
        try {
            await logout(page, before);
        }
        catch {
            // 站点改版、入口找不到:退回到打开首页、由用户自己退出
        }
        await page.goto(loginUrl);
        loggedOut = (await readKey()) !== beforeKey;
        if (!loggedOut) await page.goto(homeUrl);
    }
    else {
        await page.goto(before ? homeUrl : loginUrl);
    }
    let lastKey = await readKey();

    while (Date.now() < deadline) {
        await page.wait(Math.min(POLL_SECONDS, Math.max(0.2, (deadline - Date.now()) / 1000)));
        const key = await readKey();
        if (key === lastKey) continue;
        // 还在登录页(例如扫完第一次码被转到另一个地区的登录页):先不探测,lastKey 不动,离开登录页后再比
        if (loginInProgress && await loginInProgress(page).catch(() => false)) continue;
        lastKey = key;
        if (!key) continue;
        let after;
        try {
            after = await probe();
        }
        catch {
            // 页面还在跳转之类的临时失败:下一轮再探
            lastKey = null;
            continue;
        }
        if (!after) continue;
        const same = beforeId !== null && identify(after, key) === beforeId;
        if (same && !loggedOut) continue;
        return { status: same ? 'same_account' : 'switched', previous: displayName(before), ...after };
    }
    throw new TimeoutError(`${site} switch-account`, waitSeconds, 'No login was detected on the opened page. Sign in with the account you want, then retry.');
}

export function registerSiteSwitchCommand({ site, domain, columns, ...options }) {
    cli({
        site,
        name: 'switch-account',
        access: 'write',
        description: `Open ${site} in the browser and wait until a different account is logged in`,
        domain,
        strategy: Strategy.COOKIE,
        browser: true,
        navigateBefore: false,
        defaultWindowMode: 'foreground',
        siteSession: 'persistent',
        // 声明 timeout 参数,opencli 才按它给整条命令计时;不声明就落到全局 60s,等不到用户扫码
        args: [TIMEOUT_ARG],
        columns: ['status', 'previous', 'logged_in', 'site', ...columns],
        func: async (page, kwargs) => {
            const whoami = options.whoami ?? getRegistry().get(`${site}/whoami`)?.func;
            if (!whoami) throw new CommandExecutionError(`${site}/whoami is not registered`);
            return switchAccount(page, site, { ...options, whoami }, { waitSeconds: waitSecondsOf(kwargs?.timeout) });
        },
    });
}
