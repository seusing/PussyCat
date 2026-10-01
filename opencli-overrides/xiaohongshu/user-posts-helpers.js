import { ArgumentError } from '@jackwener/opencli/errors';

export const MAX_POSTED_NOTES = 1000;
const DAY_MS = 86_400_000;
const BEIJING_OFFSET_MS = 8 * 3_600_000;
const RANGE_DAYS = { '3d': 3, '7d': 7, '15d': 15, '1m': 30, '3m': 90, '6m': 180 };
export const RANGES = ['all', 'today', ...Object.keys(RANGE_DAYS)];
export const SORTS = ['time', 'likes'];

export function parseChoice(name, value, choices, fallback) {
    const chosen = String(value ?? fallback);
    if (!choices.includes(chosen)) {
        throw new ArgumentError(`--${name} must be one of ${choices.join(', ')}, got ${JSON.stringify(value)}`);
    }
    return chosen;
}

export function parseTimeoutSeconds(value) {
    const seconds = Number(value ?? 600);
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 600) {
        throw new ArgumentError(`--timeout must be an integer between 30 and 600, got ${JSON.stringify(value)}`);
    }
    return seconds;
}

/** 时间范围的起点（毫秒）；"今天"从北京时间当天 0 点算起，all 不限。 */
export function rangeStartMs(range, now) {
    if (range === 'all') return null;
    if (range === 'today') {
        const local = now + BEIJING_OFFSET_MS;
        return local - (local % DAY_MS) - BEIJING_OFFSET_MS;
    }
    return now - RANGE_DAYS[range] * DAY_MS;
}

/** 接受博主 id 或主页链接；主页链接里的 xsec_token 保留下来，部分主页不带它打不开。 */
export function parseXhsProfileTarget(input) {
    const raw = String(input ?? '').trim();
    if (!raw) throw new ArgumentError('Missing Xiaohongshu user id or profile URL');
    let url = null;
    try {
        url = new URL(raw);
    } catch {
        url = null;
    }
    if (!url) return { userId: raw.replace(/[?#].*$/, ''), xsecToken: '', xsecSource: '' };
    const match = url.pathname.match(/\/user\/profile\/([^/]+)/);
    const userId = match ? match[1] : '';
    if (!userId) throw new ArgumentError(`Not a Xiaohongshu profile URL: ${raw}`);
    return {
        userId,
        xsecToken: url.searchParams.get('xsec_token') || '',
        xsecSource: url.searchParams.get('xsec_source') || '',
    };
}

export function buildProfileUrl({ userId, xsecToken, xsecSource }) {
    const base = `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}`;
    if (!xsecToken) return base;
    return `${base}?${new URLSearchParams({ xsec_token: xsecToken, xsec_source: xsecSource || 'pc_note' })}`;
}

export function buildNoteUrl(noteId, xsecToken) {
    const base = `https://www.xiaohongshu.com/explore/${noteId}`;
    if (!xsecToken) return base;
    return `${base}?${new URLSearchParams({ xsec_token: xsecToken, xsec_source: 'pc_user' })}`;
}

/** "1.2万" / "3千" / "1亿" / "10w" / "1,234" / "999+" → 数字。 */
export function parseXhsCount(text) {
    const value = String(text ?? '').replace(/[,\s+]/g, '');
    const match = value.match(/^(\d+(?:\.\d+)?)(万|w|W|千|k|K|亿)?$/);
    if (!match) return 0;
    const unit = { 万: 1e4, w: 1e4, W: 1e4, 千: 1e3, k: 1e3, K: 1e3, 亿: 1e8 }[match[2]] ?? 1;
    return Math.round(Number(match[1]) * unit);
}

/** 优先用卡片自带的发布时间；缺失时按笔记 id 前 8 位十六进制（创建时间戳）推算。 */
export function noteTimeMs(note) {
    if (Number.isFinite(note.time) && note.time > 0) return note.time;
    const seconds = parseInt(String(note.id || '').slice(0, 8), 16);
    return Number.isFinite(seconds) && seconds > 1e9 && seconds < 4e9 ? seconds * 1000 : 0;
}

export function formatBeijingTime(ms) {
    if (!ms) return '';
    return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** 主页按发布时间从新到旧排列；出现一条早于起点的非置顶笔记，后面就都更早了。 */
export function reachedRangeEnd(notes, startMs) {
    if (startMs === null) return false;
    return notes.some((note) => {
        const time = noteTimeMs(note);
        return !note.sticky && time > 0 && time < startMs;
    });
}

export function selectPostedNotes(notes, { startMs, sort }) {
    const seen = new Set();
    const rows = [];
    for (const note of notes) {
        if (!note.id || seen.has(note.id)) continue;
        seen.add(note.id);
        const time = noteTimeMs(note);
        if (startMs !== null && (!time || time < startMs)) continue;
        rows.push({
            title: note.title,
            type: note.type,
            likes: note.likes,
            likes_count: parseXhsCount(note.likes),
            published_at: formatBeijingTime(time),
            url: buildNoteUrl(note.id, note.xsecToken),
            time,
        });
    }
    rows.sort(sort === 'likes'
        ? (a, b) => b.likes_count - a.likes_count || b.time - a.time
        : (a, b) => b.time - a.time);
    return rows.map(({ time, ...row }, index) => ({ rank: index + 1, ...row }));
}

/** 读取主页"笔记"标签（notes[0] / noteQueries[0]）已加载的笔记和是否还有下一页。 */
export const POSTED_STATE_JS = `
  (() => {
    const val = (value) => (value && typeof value === 'object' && '_value' in value ? value._value : value);
    const user = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user;
    const path = (typeof location !== 'undefined' && location.pathname) || '';
    const onLoginPage = path.indexOf('/login') === 0;
    if (!user || typeof user !== 'object') {
      return { storePresent: false, loginWall: onLoginPage, notes: [], hasMore: false };
    }
    const groups = val(user.notes);
    const queries = val(user.noteQueries);
    const posted = Array.isArray(groups) && Array.isArray(groups[0]) ? groups[0] : [];
    const query = Array.isArray(queries) ? queries[0] : null;
    const notes = posted.map((entry) => {
      const card = (entry && entry.noteCard) || entry || {};
      const interact = card.interactInfo || {};
      return {
        id: card.noteId || (entry && entry.id) || '',
        title: card.displayTitle || '',
        type: card.type || '',
        likes: String(interact.likedCount ?? ''),
        sticky: interact.sticky === true,
        time: typeof card.time === 'number' ? card.time : 0,
        xsecToken: (entry && entry.xsecToken) || card.xsecToken || '',
      };
    });
    return {
      storePresent: true,
      loginWall: onLoginPage || val(user.loggedIn) === false,
      notes,
      hasMore: Boolean(query && query.hasMore !== false),
    };
  })()
`;
