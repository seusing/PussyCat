import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import {
    MAX_POSTED_NOTES,
    POSTED_STATE_JS,
    RANGES,
    SORTS,
    buildProfileUrl,
    parseChoice,
    parseTimeoutSeconds,
    parseXhsProfileTarget,
    rangeStartMs,
    reachedRangeEnd,
    selectPostedNotes,
} from './user-posts-helpers.js';

function unwrapEvaluateResult(payload) {
    if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
        return payload.data;
    }
    return payload;
}

async function readPostedState(page) {
    const state = unwrapEvaluateResult(await page.evaluate(POSTED_STATE_JS));
    if (!state || typeof state !== 'object' || !Array.isArray(state.notes)) {
        throw new CommandExecutionError('Malformed Xiaohongshu profile snapshot');
    }
    return state;
}

export async function fetchUserPosts(page, kwargs, { now = Date.now, random = Math.random } = {}) {
    const target = parseXhsProfileTarget(kwargs.id);
    const range = parseChoice('range', kwargs.range, RANGES, 'all');
    const sort = parseChoice('sort', kwargs.sort, SORTS, 'time');
    const startedAt = now();
    const startMs = rangeStartMs(range, startedAt);
    // 留 20 秒给收尾，避免被 opencli 的命令超时直接中断而拿不到已加载的笔记。
    const deadline = startedAt + (parseTimeoutSeconds(kwargs.timeout) - 20) * 1000;
    // 浏览器扩展会拒绝新开的自动化标签页直接跳到他人主页，先进发现页再进主页就能打开。
    await page.goto('https://www.xiaohongshu.com/explore');
    await page.goto(buildProfileUrl(target));
    let state = await readPostedState(page);
    for (let attempt = 0; attempt < 8 && state.storePresent && !state.loginWall && state.notes.length === 0 && state.hasMore; attempt++) {
        await page.wait(2);
        state = await readPostedState(page);
    }
    if (state.loginWall) {
        throw new AuthRequiredError('www.xiaohongshu.com', 'Xiaohongshu profile is behind a login wall');
    }
    if (!state.storePresent) {
        throw new CommandExecutionError('Malformed Xiaohongshu profile snapshot: user store was not found');
    }
    let stalls = 0;
    while (state.hasMore && state.notes.length < MAX_POSTED_NOTES && !reachedRangeEnd(state.notes, startMs) && now() < deadline) {
        await page.autoScroll({ times: 1, delayMs: 800 });
        await page.wait(1.2 + random() * 1.3);
        const next = await readPostedState(page);
        stalls = next.notes.length > state.notes.length ? 0 : stalls + 1;
        state = next;
        if (stalls >= 3) break;
    }
    if (state.notes.length === 0) {
        throw new EmptyResultError('xiaohongshu user-posts', '该用户没有公开笔记（可能销号 / 私密 / 全部删除）。');
    }
    return selectPostedNotes(state.notes.slice(0, MAX_POSTED_NOTES), { startMs, sort });
}

cli({
    site: 'xiaohongshu',
    name: 'user-posts',
    access: 'read',
    description: 'List all notes of a Xiaohongshu user, filtered by publish time and sorted by time or likes',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'id', type: 'string', required: true, positional: true, help: 'User id or profile URL' },
        { name: 'range', type: 'string', default: 'all', choices: RANGES, help: 'Publish time range' },
        { name: 'sort', type: 'string', default: 'time', choices: SORTS, help: 'Sort by publish time or likes' },
        { name: 'timeout', type: 'int', default: 600, help: 'Max seconds to spend scrolling the profile' },
    ],
    columns: ['rank', 'title', 'type', 'likes', 'published_at', 'url'],
    func: (page, kwargs) => fetchUserPosts(page, kwargs),
});
