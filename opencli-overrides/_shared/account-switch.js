import { AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, getRegistry, Strategy } from '@jackwener/opencli/registry';

// 爪爪原生:切换账号。上游 login 已登录时直接返回,换不了号。这里先记下当前账号,在前台打开站点,
// 由用户在页面里退出、登录另一个账号;看到换了人才结束。全程不改 cookie。
export const WAIT_SECONDS = 300;
const POLL_SECONDS = 2;

function displayName(identity) {
    return String(identity?.username || identity?.name || identity?.id || '');
}

/**
 * 换号流程本身,与站点无关。site 文件提供:
 * - whoami(page):会跳转页面的身份探测(复用上游 whoami),未登录抛 AuthRequiredError;
 * - accountKey(page):不跳转的会话指纹,未登录或看不出时返回 '';它一变才去探测身份;
 * - identify(identity, key):判断「是不是同一个人」用的标识;
 * - homeUrl / loginUrl:已登录时打开首页让用户退出,未登录时直接打开登录页。
 */
export async function switchAccount(page, site, { whoami, accountKey, identify, homeUrl, loginUrl }, { waitSeconds = WAIT_SECONDS } = {}) {
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
    let lastKey = await readKey();
    const beforeId = before ? identify(before, lastKey) : null;
    // 扩展只在新建标签租约时把窗口调到前台;沿用 whoami 留下的后台标签,窗口会一直待在后面(或最小化)。
    // 先释放该站会话,下一次跳转就新建租约,按本命令的 foreground 把窗口拉到前面。
    await page.closeWindow();
    await page.goto(before ? homeUrl : loginUrl);

    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
        await page.wait(Math.min(POLL_SECONDS, Math.max(0.2, (deadline - Date.now()) / 1000)));
        const key = await readKey();
        if (key === lastKey) continue;
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
        if (beforeId !== null && identify(after, key) === beforeId) continue;
        return { status: 'switched', previous: displayName(before), ...after };
    }
    throw new TimeoutError(`${site} switch-account`, waitSeconds, 'No account change was detected. Log out on the opened page, sign in with another account, then retry.');
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
        args: [],
        columns: ['status', 'previous', 'logged_in', 'site', ...columns],
        func: async (page) => {
            const whoami = getRegistry().get(`${site}/whoami`)?.func;
            if (!whoami) throw new CommandExecutionError(`${site}/whoami is not registered`);
            return switchAccount(page, site, { ...options, whoami });
        },
    });
}
