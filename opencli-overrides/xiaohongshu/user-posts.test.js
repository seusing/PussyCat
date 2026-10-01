import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ArgumentError, AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import {
    POSTED_STATE_JS,
    buildNoteUrl,
    buildProfileUrl,
    noteTimeMs,
    parseXhsCount,
    parseXhsProfileTarget,
    rangeStartMs,
    reachedRangeEnd,
    selectPostedNotes,
} from './user-posts-helpers.js';
import { fetchUserPosts } from './user-posts.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const note = (id, time, extra = {}) => ({ id, title: `笔记${id}`, type: 'video', likes: '1', sticky: false, time, xsecToken: `t-${id}`, ...extra });

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
        expect(parseXhsProfileTarget('6836832c000000001d00be52')).toEqual({ userId: '6836832c000000001d00be52', xsecToken: '', xsecSource: '' });
        expect(parseXhsProfileTarget('https://www.xiaohongshu.com/user/profile/abc?xsec_token=T&xsec_source=pc_search')).toEqual({ userId: 'abc', xsecToken: 'T', xsecSource: 'pc_search' });
        expect(() => parseXhsProfileTarget('https://www.xiaohongshu.com/explore/123')).toThrow(ArgumentError);
        expect(buildProfileUrl({ userId: 'abc', xsecToken: 'T', xsecSource: '' })).toBe('https://www.xiaohongshu.com/user/profile/abc?xsec_token=T&xsec_source=pc_note');
        expect(buildNoteUrl('n1', 'T')).toBe('https://www.xiaohongshu.com/explore/n1?xsec_token=T&xsec_source=pc_user');
        expect(buildNoteUrl('n1', '')).toBe('https://www.xiaohongshu.com/explore/n1');
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
        expect(command.args.map((arg) => arg.name)).toEqual(['id', 'range', 'sort', 'timeout']);
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
        const rows = await fetchUserPosts(page, { id: 'u', range: '7d', sort: 'time', timeout: 600 }, { now: () => 31 * DAY, random: () => 0 });
        expect(page.autoScroll).not.toHaveBeenCalled();
        expect(rows.map((row) => row.title)).toEqual(['笔记a']);
    });

    it('reports a login wall and an empty profile distinctly', async () => {
        await expect(fetchUserPosts(profilePage([{ storePresent: true, loginWall: true, notes: [], hasMore: false }]), { id: 'u' }))
            .rejects.toBeInstanceOf(AuthRequiredError);
        await expect(fetchUserPosts(profilePage([loaded([], false)]), { id: 'u' }))
            .rejects.toBeInstanceOf(EmptyResultError);
    });

    it('rejects an unknown range', async () => {
        await expect(fetchUserPosts(profilePage([loaded([], false)]), { id: 'u', range: '2d' }))
            .rejects.toBeInstanceOf(ArgumentError);
    });
});
