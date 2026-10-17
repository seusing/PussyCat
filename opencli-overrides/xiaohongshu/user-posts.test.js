import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import {
    POSTED_STATE_JS,
    buildNoteUrl,
    buildProfileUrl,
    noteTimeMs,
    parseKeywords,
    parseXhsCount,
    rangeStartMs,
    reachedRangeEnd,
    selectPostedNotes,
} from './user-posts-helpers.js';
import { parseXhsProfileTarget, resolveXhsProfileTarget } from './short-link.js';
import { fetchUserPosts } from './user-posts.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const note = (id, time, extra = {}) => ({ id, title: `笔记${id}`, type: 'video', likes: '1', sticky: false, time, xsecToken: `t-${id}`, ...extra });
const USER_ID = '6836832c000000001d00be52';
const SHORT_LINK = 'https://xhslink.cn/m/9HpfvCBRfr3';
const SHARED_PROFILE = 'https://www.xiaohongshu.com/user/profile/63b98bad0000000026010302?xsec_token=YB0A8B0snagcgYQB8wcA8p4kfwLEul40CDqJU82B7JiR4=&xsec_source=app_share&xhsshare=CopyLink&shareRedId=ODYyMDQ-RTw2NzUyOTgwNjY0OTc1PD0_&apptime=1792120761&share_id=11a6ce7e4d9644f4ad6e47776c49284b';
const SHARED_TARGET = { userId: '63b98bad0000000026010302', xsecToken: 'YB0A8B0snagcgYQB8wcA8p4kfwLEul40CDqJU82B7JiR4=', xsecSource: 'app_share' };
const redirectingFetch = (location) => vi.fn(async () => new Response(null, { status: location ? 302 : 200, headers: location ? { location } : {} }));

describe('xiaohongshu user-posts helpers', () => {
    it('starts "today" at Beijing midnight and other ranges from now', () => {
        expect(rangeStartMs('today', Date.UTC(2026, 8, 29, 1))).toBe(Date.UTC(2026, 8, 28, 16));
        expect(rangeStartMs('today', Date.UTC(2026, 8, 28, 17))).toBe(Date.UTC(2026, 8, 28, 16));
        expect(rangeStartMs('today', Date.UTC(2026, 8, 28, 15))).toBe(Date.UTC(2026, 8, 27, 16));
        expect(rangeStartMs('7d', 100 * DAY)).toBe(93 * DAY);
        expect(rangeStartMs('15d', 100 * DAY)).toBe(85 * DAY);
        expect(rangeStartMs('all', 100 * DAY)).toBeNull();
    });

    it('converts like counts written with units', () => {
        expect(parseXhsCount('1.2万')).toBe(12000);
        expect(parseXhsCount('3千')).toBe(3000);
        expect(parseXhsCount('1亿')).toBe(100000000);
        expect(parseXhsCount('10w')).toBe(100000);
        expect(parseXhsCount('1,234')).toBe(1234);
        expect(parseXhsCount('999+')).toBe(999);
        expect(parseXhsCount('赞')).toBe(0);
    });

    it('accepts a user id or a profile URL and keeps its xsec_token', () => {
        expect(parseXhsProfileTarget(USER_ID)).toEqual({ userId: USER_ID, xsecToken: '', xsecSource: '' });
        expect(parseXhsProfileTarget('https://www.xiaohongshu.com/user/profile/abc?xsec_token=T&xsec_source=pc_search')).toEqual({ userId: 'abc', xsecToken: 'T', xsecSource: 'pc_search' });
        expect(() => parseXhsProfileTarget('https://www.xiaohongshu.com/explore/123')).toThrow(ArgumentError);
        for (const input of ['u', 'abc', '复制后打开小红书', USER_ID.slice(1), `${USER_ID}0`]) {
            expect(() => parseXhsProfileTarget(input)).toThrow('请填写小红书博主 ID 或主页链接');
        }
        expect(buildProfileUrl({ userId: 'abc', xsecToken: 'T', xsecSource: '' })).toBe('https://www.xiaohongshu.com/user/profile/abc?xsec_token=T&xsec_source=pc_note');
        expect(buildNoteUrl('n1', 'T')).toBe('https://www.xiaohongshu.com/explore/n1?xsec_token=T&xsec_source=pc_user');
        expect(buildNoteUrl('n1', '')).toBe('https://www.xiaohongshu.com/explore/n1');
    });

    it('resolves an xhslink short link with one non-following request and keeps the share token', async () => {
        const fetch = redirectingFetch(SHARED_PROFILE);
        await expect(resolveXhsProfileTarget(SHORT_LINK, { fetch })).resolves.toEqual(SHARED_TARGET);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(SHORT_LINK, expect.objectContaining({ redirect: 'manual' }));
    });

    it('recognises xhslink.com and subdomains in any letter case', async () => {
        for (const link of ['http://xhslink.com/a/AbCd', 'https://XHSLINK.COM/m/AbCd', ' https://www.xhslink.cn/m/AbCd ']) {
            const fetch = redirectingFetch(SHARED_PROFILE);
            await expect(resolveXhsProfileTarget(link, { fetch })).resolves.toEqual(SHARED_TARGET);
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(fetch.mock.calls[0][0]).toBe(link.trim());
        }
    });

    it('takes the short link or the full profile link out of a profile share text', async () => {
        const shortFetch = redirectingFetch(SHARED_PROFILE);
        await expect(resolveXhsProfileTarget(`我在小红书发现了一个宝藏博主 ${SHORT_LINK} 复制本条信息打开App`, { fetch: shortFetch })).resolves.toEqual(SHARED_TARGET);
        await expect(resolveXhsProfileTarget(`宝藏博主 ${SHORT_LINK}，复制本条信息打开App`, { fetch: shortFetch })).resolves.toEqual(SHARED_TARGET);
        expect(shortFetch).toHaveBeenCalledTimes(2);
        expect(shortFetch.mock.calls.map(([url]) => url)).toEqual([SHORT_LINK, SHORT_LINK]);

        const fullFetch = redirectingFetch(SHARED_PROFILE);
        await expect(resolveXhsProfileTarget(`宝藏博主 ${SHARED_PROFILE} 复制本条信息打开App`, { fetch: fullFetch })).resolves.toEqual(SHARED_TARGET);
        expect(fullFetch).not.toHaveBeenCalled();
    });

    it('resolves user ids and full profile URLs without any request', async () => {
        const fetch = redirectingFetch(SHARED_PROFILE);
        for (const input of [USER_ID, 'https://www.xiaohongshu.com/user/profile/abc?xsec_token=T&xsec_source=pc_search', 'https://example.com/xhslink.cn/user/profile/abc']) {
            await expect(resolveXhsProfileTarget(input, { fetch })).resolves.toEqual(parseXhsProfileTarget(input));
        }
        await expect(resolveXhsProfileTarget('https://www.xiaohongshu.com/explore/123', { fetch })).rejects.toThrow(ArgumentError);
        await expect(resolveXhsProfileTarget('  ', { fetch })).rejects.toThrow(ArgumentError);
        await expect(resolveXhsProfileTarget('复制后打开小红书', { fetch })).rejects.toThrow(ArgumentError);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects short links that do not land on a profile and names the destination', async () => {
        const cases = [
            ['https://www.xiaohongshu.com', 'https://www.xiaohongshu.com'],
            ['https://www.xiaohongshu.com/discovery/item/68f0000000000000000000aa?xsec_token=T', 'https://www.xiaohongshu.com/discovery/item/68f0000000000000000000aa?xsec_token=T'],
            ['', '没有跳转'],
        ];
        for (const [location, shown] of cases) {
            const error = await resolveXhsProfileTarget(SHORT_LINK, { fetch: redirectingFetch(location) }).catch((e) => e);
            expect(error).toBeInstanceOf(ArgumentError);
            expect(error.message).toContain(SHORT_LINK);
            expect(error.message).toContain('博主主页');
            expect(error.message).toContain(shown);
            expect(error.hint).toContain('分享 → 复制链接');
        }
    });

    it('reports a failed short link request as a command error', async () => {
        const fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
        const error = await resolveXhsProfileTarget(SHORT_LINK, { fetch }).catch((e) => e);
        expect(error).toBeInstanceOf(CommandExecutionError);
        expect(error.message).toContain('短链接');
        expect(error.message).toContain('fetch failed');
    });

    it('prefers the card time and falls back to the note id timestamp', () => {
        expect(noteTimeMs({ id: '6abafb5f0000000014000972', time: 1790638943000 })).toBe(1790638943000);
        expect(noteTimeMs({ id: '6abafb5f0000000014000972', time: 0 })).toBe(0x6abafb5f * 1000);
    });

    it('stops at the first older non-pinned note only', () => {
        const start = 10 * DAY;
        expect(reachedRangeEnd([note('a', 12 * DAY), note('b', 5 * DAY, { sticky: true })], start)).toBe(false);
        expect(reachedRangeEnd([note('a', 12 * DAY), note('c', 9 * DAY)], start)).toBe(true);
        expect(reachedRangeEnd([note('c', 1 * DAY)], null)).toBe(false);
    });

    it('filters by range, removes duplicates and sorts by time or likes', () => {
        const notes = [
            note('old-pin', 1 * DAY, { sticky: true, likes: '9万' }),
            note('a', 12 * DAY, { likes: '10' }),
            note('b', 11 * DAY, { likes: '1.2万' }),
            note('a', 12 * DAY, { likes: '10' }),
            note('c', 5 * DAY, { likes: '3千' }),
        ];
        const byTime = selectPostedNotes(notes, { startMs: 10 * DAY, sort: 'time' });
        expect(byTime.map((row) => row.url)).toEqual([buildNoteUrl('a', 't-a'), buildNoteUrl('b', 't-b')]);
        expect(byTime[0]).toMatchObject({ rank: 1, title: '笔记a', type: 'video', likes: '10', likes_count: 10 });
        expect(byTime[0]).not.toHaveProperty('time');
        const byLikes = selectPostedNotes(notes, { startMs: null, sort: 'likes' });
        expect(byLikes.map((row) => row.likes_count)).toEqual([90000, 12000, 3000, 10]);
    });

    it('splits keywords on any whitespace and drops empty and case-duplicate words', () => {
        expect(parseKeywords(undefined)).toEqual([]);
        expect(parseKeywords(null)).toEqual([]);
        expect(parseKeywords('')).toEqual([]);
        expect(parseKeywords('   ')).toEqual([]);
        expect(parseKeywords('  美食   探店  ')).toEqual(['美食', '探店']);
        expect(parseKeywords('美食　探店\t打卡')).toEqual(['美食', '探店', '打卡']);
        expect(parseKeywords('Vlog vlog VLOG 日常')).toEqual(['Vlog', '日常']);
    });

    it('keeps only notes whose title contains every keyword, ignoring case', () => {
        const notes = [
            note('a', 12 * DAY, { title: 'Vlog｜周末探店' }),
            note('b', 11 * DAY, { title: '周末在家' }),
            note('c', 10 * DAY, { title: '探店 vlog 合集' }),
            note('d', 9 * DAY, { title: '' }),
        ];
        const titles = (keywords) => selectPostedNotes(notes, { startMs: null, sort: 'time', keywords }).map((row) => row.title);
        expect(titles(['探店'])).toEqual(['Vlog｜周末探店', '探店 vlog 合集']);
        expect(titles(['VLOG', '探店'])).toEqual(['Vlog｜周末探店', '探店 vlog 合集']);
        expect(titles(['周末', '探店'])).toEqual(['Vlog｜周末探店']);
        expect(titles(['周末', '合集'])).toEqual([]);
        expect(titles([])).toEqual(['Vlog｜周末探店', '周末在家', '探店 vlog 合集', '']);
        expect(selectPostedNotes(notes, { startMs: null, sort: 'time' })).toHaveLength(4);
    });

    it('applies keywords together with range and sort and numbers ranks from 1', () => {
        const notes = [
            note('a', 12 * DAY, { title: '探店A', likes: '10' }),
            note('b', 11 * DAY, { title: '日常B', likes: '9万' }),
            note('c', 11 * DAY - HOUR, { title: '探店C', likes: '1.2万' }),
            note('old', 5 * DAY, { title: '探店旧', likes: '5万' }),
            note('a', 12 * DAY, { title: '探店A', likes: '10' }),
        ];
        const byTime = selectPostedNotes(notes, { startMs: 10 * DAY, sort: 'time', keywords: ['探店'] });
        expect(byTime.map((row) => [row.rank, row.title])).toEqual([[1, '探店A'], [2, '探店C']]);
        const byLikes = selectPostedNotes(notes, { startMs: 10 * DAY, sort: 'likes', keywords: ['探店'] });
        expect(byLikes.map((row) => [row.rank, row.title])).toEqual([[1, '探店C'], [2, '探店A']]);
        expect(selectPostedNotes(notes, { startMs: null, sort: 'likes', keywords: ['探店'] }).map((row) => row.title)).toEqual(['探店旧', '探店C', '探店A']);
        expect(selectPostedNotes(notes, { startMs: 10 * DAY, sort: 'time', keywords: ['不存在'] })).toEqual([]);
    });

    it('reads the posted tab from the hydrated profile store', () => {
        const window = { __INITIAL_STATE__: { user: {
            loggedIn: { _value: true },
            notes: { _value: [[{ id: 'n1', xsecToken: 'T', noteCard: { noteId: 'n1', displayTitle: '标题', type: 'video', time: 5, interactInfo: { likedCount: '6', sticky: true } } }], []] },
            noteQueries: { _value: [{ hasMore: false }, { hasMore: true }] },
        } } };
        const state = runInNewContext(POSTED_STATE_JS, { window, location: { pathname: '/user/profile/u' } });
        expect(state).toEqual({
            storePresent: true,
            loginWall: false,
            notes: [{ id: 'n1', title: '标题', type: 'video', likes: '6', sticky: true, time: 5, xsecToken: 'T' }],
            hasMore: false,
        });
    });
});

function profilePage(states) {
    let index = 0;
    return {
        goto: vi.fn(),
        wait: vi.fn(),
        autoScroll: vi.fn(async () => { index = Math.min(index + 1, states.length - 1); }),
        evaluate: vi.fn(async () => states[index]),
    };
}

const loaded = (notes, hasMore) => ({ storePresent: true, loginWall: false, notes, hasMore });

describe('xiaohongshu user-posts command', () => {
    it('is registered as a read-only browser command with the documented options', () => {
        const command = getRegistry().get('xiaohongshu/user-posts');
        expect(command).toMatchObject({ access: 'read', browser: true });
        expect(command.args.map((arg) => arg.name)).toEqual(['id', 'keyword', 'range', 'sort', 'timeout']);
        expect(command.args.find((arg) => arg.name === 'keyword')).toMatchObject({ type: 'string', required: false });
    });

    it('scrolls until the profile has no more notes', async () => {
        const page = profilePage([
            loaded([note('a', 30 * DAY)], true),
            loaded([note('a', 30 * DAY), note('b', 29 * DAY)], true),
            loaded([note('a', 30 * DAY), note('b', 29 * DAY), note('c', 28 * DAY)], false),
        ]);
        const rows = await fetchUserPosts(page, { id: 'https://www.xiaohongshu.com/user/profile/u?xsec_token=T', range: 'all', sort: 'time', timeout: 600 }, { now: () => 31 * DAY, random: () => 0 });
        expect(page.goto.mock.calls.map(([url]) => url)).toEqual([
            'https://www.xiaohongshu.com/explore',
            'https://www.xiaohongshu.com/user/profile/u?xsec_token=T&xsec_source=pc_note',
        ]);
        expect(page.autoScroll).toHaveBeenCalledTimes(2);
        expect(rows.map((row) => row.title)).toEqual(['笔记a', '笔记b', '笔记c']);
    });

    it('stops scrolling once notes fall outside the time range', async () => {
        const page = profilePage([
            loaded([note('a', 30 * DAY), note('old', 20 * DAY)], true),
            loaded([note('a', 30 * DAY), note('old', 20 * DAY), note('older', 19 * DAY)], true),
        ]);
        const rows = await fetchUserPosts(page, { id: USER_ID, range: '7d', sort: 'time', timeout: 600 }, { now: () => 31 * DAY, random: () => 0 });
        expect(page.autoScroll).not.toHaveBeenCalled();
        expect(rows.map((row) => row.title)).toEqual(['笔记a']);
    });

    it('filters by title keywords locally without changing the browser navigation', async () => {
        const states = () => [
            loaded([note('a', 30 * DAY, { title: '周末探店' })], true),
            loaded([note('a', 30 * DAY, { title: '周末探店' }), note('b', 29 * DAY, { title: '日常' })], true),
            loaded([note('a', 30 * DAY, { title: '周末探店' }), note('b', 29 * DAY, { title: '日常' }), note('c', 28 * DAY, { title: '探店 周末 合集' })], false),
        ];
        const options = { now: () => 31 * DAY, random: () => 0 };
        const plainPage = profilePage(states());
        await fetchUserPosts(plainPage, { id: USER_ID, range: 'all', sort: 'time', timeout: 600 }, options);
        const keywordPage = profilePage(states());
        const fetch = redirectingFetch(SHARED_PROFILE);
        const rows = await fetchUserPosts(keywordPage, { id: USER_ID, keyword: ' 探店　周末 ', range: 'all', sort: 'time', timeout: 600 }, { ...options, fetch });
        expect(keywordPage.goto.mock.calls).toEqual(plainPage.goto.mock.calls);
        expect(keywordPage.autoScroll).toHaveBeenCalledTimes(plainPage.autoScroll.mock.calls.length);
        expect(fetch).not.toHaveBeenCalled();
        expect(rows.map((row) => [row.rank, row.title])).toEqual([[1, '周末探店'], [2, '探店 周末 合集']]);
        const none = await fetchUserPosts(profilePage(states()), { id: USER_ID, keyword: '不存在' }, options);
        expect(none).toEqual([]);
    });

    it('reports a login wall and an empty profile distinctly', async () => {
        await expect(fetchUserPosts(profilePage([{ storePresent: true, loginWall: true, notes: [], hasMore: false }]), { id: USER_ID }))
            .rejects.toBeInstanceOf(AuthRequiredError);
        await expect(fetchUserPosts(profilePage([loaded([], false)]), { id: USER_ID }))
            .rejects.toBeInstanceOf(EmptyResultError);
    });

    it('opens the profile behind a shared short link', async () => {
        const page = profilePage([loaded([note('a', 30 * DAY)], false)]);
        const fetch = redirectingFetch(SHARED_PROFILE);
        const rows = await fetchUserPosts(page, { id: SHORT_LINK }, { now: () => 31 * DAY, random: () => 0, fetch });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(page.goto.mock.calls.map(([url]) => url)).toEqual([
            'https://www.xiaohongshu.com/explore',
            'https://www.xiaohongshu.com/user/profile/63b98bad0000000026010302?xsec_token=YB0A8B0snagcgYQB8wcA8p4kfwLEul40CDqJU82B7JiR4%3D&xsec_source=app_share',
        ]);
        expect(rows.map((row) => row.title)).toEqual(['笔记a']);
    });

    it('does not open the browser when the short link cannot be resolved or the options are wrong', async () => {
        const page = profilePage([loaded([], false)]);
        await expect(fetchUserPosts(page, { id: SHORT_LINK }, { fetch: redirectingFetch('https://www.xiaohongshu.com') }))
            .rejects.toBeInstanceOf(ArgumentError);
        const failing = vi.fn(async () => { throw new TypeError('fetch failed'); });
        await expect(fetchUserPosts(page, { id: SHORT_LINK }, { fetch: failing }))
            .rejects.toBeInstanceOf(CommandExecutionError);
        const unused = redirectingFetch(SHARED_PROFILE);
        await expect(fetchUserPosts(page, { id: SHORT_LINK, range: '2d' }, { fetch: unused }))
            .rejects.toBeInstanceOf(ArgumentError);
        expect(unused).not.toHaveBeenCalled();
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('rejects an unknown range', async () => {
        await expect(fetchUserPosts(profilePage([loaded([], false)]), { id: USER_ID, range: '2d' }))
            .rejects.toBeInstanceOf(ArgumentError);
    });
});
