import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
function buildXhsNoteUrl(userId, noteId, xsecToken) {
    const url = new URL(`https://www.xiaohongshu.com/user/profile/${String(userId).trim()}/${String(noteId).trim()}`);
    if (String(xsecToken ?? '').trim()) {
        url.searchParams.set('xsec_token', String(xsecToken).trim());
        url.searchParams.set('xsec_source', 'pc_user');
    }
    return url.toString();
}

function normalizeXhsUserId(input) {
    const trimmed = String(input ?? '').trim().replace(/[?#].*$/, '');
    const matched = trimmed.match(/\/user\/profile\/([a-zA-Z0-9]+)/);
    return matched?.[1] ?? trimmed.replace(/\/+$/, '').split('/').pop() ?? trimmed;
}

export const COLLECT_API_PATTERN = 'note/collect/page';
export const LIKE_API_PATTERN = 'note/like/page';
export const SAVED_PROFILE_TAB = 'fav';
export const LIKED_PROFILE_TAB = 'liked';
export const ALBUM_PROFILE_SUBTAB = 'board';

export function buildProfileCollectionUrl(userId, tab, subTab = 'note') {
    const cleanUserId = toCleanString(userId);
    const url = new URL(`https://www.xiaohongshu.com/user/profile/${cleanUserId}`);
    url.searchParams.set('tab', toCleanString(tab));
    url.searchParams.set('subTab', toCleanString(subTab));
    return url.toString();
}

export function buildCollectionBoardUrl(boardId) {
    return `https://www.xiaohongshu.com/board/${encodeURIComponent(toCleanString(boardId))}`;
}

function toCleanString(value) {
    return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

export function unwrapBrowserResult(payload) {
    if (isObject(payload) && 'session' in payload && 'data' in payload)
        return payload.data;
    return payload;
}

export function parseCollectionLimit(raw) {
    const parsed = Number(raw ?? 20);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed))
        throw new ArgumentError(`--limit must be an integer between 1 and 100, got ${JSON.stringify(raw)}`);
    if (parsed < 1 || parsed > 100)
        throw new ArgumentError(`--limit must be between 1 and 100, got ${parsed}`);
    return parsed;
}

export function readSelfUserIdFromState(state) {
    const unwrapped = unwrapBrowserResult(state);
    const user = unwrapped?.user?.userInfo;
    const info = user?._value ?? user ?? {};
    return toCleanString(info.user_id ?? info.userId ?? info.userID ?? '');
}

export function mapCollectionNote(entry, options = {}) {
    if (!isObject(entry)) return null;
    const noteCard = entry.note_card ?? entry.noteCard ?? entry;
    const noteId = toCleanString(entry.note_id ?? entry.noteId ?? entry.id ?? noteCard.note_id ?? noteCard.noteId ?? noteCard.id);
    if (!noteId) return null;
    const user = noteCard.user ?? entry.user ?? {};
    const userId = toCleanString(user.user_id ?? user.userId ?? '');
    const xsecToken = toCleanString(entry.xsec_token ?? entry.xsecToken ?? noteCard.xsec_token ?? noteCard.xsecToken);
    if (!xsecToken) return null;
    const interact = noteCard.interact_info ?? noteCard.interactInfo ?? entry.interact_info ?? entry.interactInfo ?? {};
    const url = userId
        ? buildXhsNoteUrl(userId, noteId, xsecToken)
        : `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_user`;
    return {
        id: noteId,
        title: toCleanString(noteCard.display_title ?? noteCard.displayTitle ?? noteCard.title ?? entry.title ?? entry.display_title),
        author: toCleanString(user.nickname ?? user.nickName ?? user.nick_name ?? user.name),
        likes: toCleanString(interact.liked_count ?? interact.likedCount ?? 0) || '0',
        type: toCleanString(noteCard.type ?? entry.type),
        url,
    };
}

export function extractNotesFromResponses(requests, fallbackUserId) {
    const rows = [];
    const seen = new Set();
    for (const req of requests ?? []) {
        const payload = unwrapBrowserResult(req);
        if (!isObject(payload)) throw new CommandExecutionError('xiaohongshu collection API returned a malformed payload');
        const data = payload.data;
        if (!isObject(data)) throw new CommandExecutionError('xiaohongshu collection API returned malformed data');
        const notes = data.notes ?? data.note_list;
        if (!Array.isArray(notes)) throw new CommandExecutionError('xiaohongshu collection API returned malformed notes');
        for (const entry of notes) {
            const row = mapCollectionNote(entry, { fallbackUserId });
            if (!row?.id || !row.url.includes('xsec_token='))
                throw new CommandExecutionError('xiaohongshu collection API returned a note without stable id/xsec token');
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            rows.push(row);
        }
    }
    return rows;
}

export const EXTRACT_COLLECTION_DOM_JS = `
  (() => {
    const normalizeUrl = (href) => {
      if (!href) return '';
      let url;
      try { url = new URL(href, 'https://www.xiaohongshu.com'); } catch { return ''; }
      if (url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com') return '';
      if (!url.searchParams.get('xsec_token')) return '';
      return url.toString();
    };
    const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const results = [], seen = new Set();
    document.querySelectorAll('section.note-item').forEach((el) => {
      if (el.classList.contains('query-note-item')) return;
      const titleEl = el.querySelector('.title, .note-title, a.title, .footer .title span');
      const nameEl = el.querySelector('a.author .name, .author-name, .nick-name, .name');
      const likesEl = el.querySelector('.count, .like-count, .like-wrapper .count');
      const detailLinkEl = el.querySelector('a.cover.mask, a[href*="/search_result/"], a[href*="/explore/"], a[href*="/note/"], a[href*="/user/profile/"], a[href*="/board/"]');
      const url = normalizeUrl(detailLinkEl?.getAttribute('href') || '');
      if (!url) return;
      const noteIdMatch = url.match(/\\/(?:search_result|explore|note)\\/([0-9a-f]{24})|\\/user\\/profile\\/[^/]+\\/([0-9a-f]{24})|\\/board\\/[^/]+\\/([0-9a-f]{24})/i);
      const id = noteIdMatch?.[1] || noteIdMatch?.[2] || noteIdMatch?.[3] || '';
      if (!id || seen.has(id)) return;
      seen.add(id);
      results.push({ id, title: cleanText(titleEl?.textContent || ''), author: cleanText(nameEl?.textContent || ''), likes: cleanText(likesEl?.textContent || '0'), type: '', url });
    });
    return results;
  })()
`;

export const EXTRACT_COLLECTIONS_DOM_JS = `
  (() => {
    const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const rows = [], seen = new Set();
    document.querySelectorAll('a[href*="/board/"]').forEach((el) => {
      const href = el.getAttribute('href') || '';
      const match = href.match(/\\/board\\/([^/?#]+)/i);
      if (!match) return;
      const id = decodeURIComponent(match[1]);
      if (!id || seen.has(id)) return;
      const text = cleanText(el.textContent);
      if (!text) return;
      seen.add(id);
      const countMatch = text.match(/笔记[·・:]?\\s*(\\d+)$/);
      const count = countMatch ? countMatch[1] : '';
      const name = cleanText(countMatch ? text.slice(0, countMatch.index).replace(/笔记\\s*$/, '').trim() : text);
      rows.push({ id, name, count, url: new URL('/board/' + encodeURIComponent(id) + '?source=web_user_page', location.origin).toString() });
    });
    return rows;
  })()
`;

const LOGIN_WALL_JS = `(() => { const pathName = location?.pathname || ''; const userStore = window.__INITIAL_STATE__?.user; const loggedInVal = userStore ? (userStore.loggedIn?._value ?? userStore.loggedIn) : undefined; const bodyText = document.body?.innerText || ''; return Boolean(pathName.indexOf('/login') === 0 || loggedInVal === false || /登录后|请先登录|登录后查看/.test(bodyText)); })()`;
const CURRENT_LOCATION_JS = `(() => ({ href: location.href, hostname: location.hostname, pathname: location.pathname }))()`;

async function throwIfLoginWall(page) {
    if (unwrapBrowserResult(await page.evaluate(LOGIN_WALL_JS)) === true)
        throw new AuthRequiredError('www.xiaohongshu.com', 'Xiaohongshu collection page requires login; re-login to xiaohongshu.com and retry.');
}

export async function assertOnCollectionProfile(page, userId) {
    await throwIfLoginWall(page);
    const payload = unwrapBrowserResult(await page.evaluate(CURRENT_LOCATION_JS));
    if (!isObject(payload)) throw new CommandExecutionError('xiaohongshu collection page returned malformed location');
    const hostname = toCleanString(payload.hostname).toLowerCase();
    const pathname = toCleanString(payload.pathname);
    const expectedPath = `/user/profile/${toCleanString(userId)}`;
    if (hostname === 'www.xiaohongshu.com' && pathname === '/login') throw new AuthRequiredError('xiaohongshu collection page requires login');
    if (hostname !== 'www.xiaohongshu.com' || pathname !== expectedPath)
        throw new CommandExecutionError(`xiaohongshu collection landed on unexpected page: ${toCleanString(payload.href) || `${hostname}${pathname}`}`);
}

async function assertOnBoardPage(page, boardId) {
    await throwIfLoginWall(page);
    const payload = unwrapBrowserResult(await page.evaluate(CURRENT_LOCATION_JS));
    const expectedPath = `/board/${toCleanString(boardId)}`;
    if (!isObject(payload) || toCleanString(payload.hostname).toLowerCase() !== 'www.xiaohongshu.com' || toCleanString(payload.pathname) !== expectedPath)
        throw new CommandExecutionError(`xiaohongshu collection board landed on unexpected page: ${toCleanString(payload?.href)}`);
}

async function accumulateInterceptedNotes(page, bucket, fallbackUserId) {
    const reqs = await page.getInterceptedRequests();
    if (!Array.isArray(reqs)) throw new CommandExecutionError('xiaohongshu collection interceptor returned malformed captures');
    if (reqs.length) bucket.push(...reqs);
    return extractNotesFromResponses(bucket, fallbackUserId);
}

export async function resolveXhsUserId(page, rawId) {
    if (rawId) return normalizeXhsUserId(String(rawId));
    await page.goto('https://www.xiaohongshu.com/explore');
    await page.wait(2);
    await throwIfLoginWall(page);
    const userId = unwrapBrowserResult(await page.evaluate(`() => { const user = window.__INITIAL_STATE__?.user?.userInfo; const info = user?._value ?? user ?? {}; return info.user_id || info.userId || info.userID || ''; }`));
    const clean = toCleanString(userId);
    if (!clean) throw new AuthRequiredError('www.xiaohongshu.com', 'Not logged into Xiaohongshu (could not resolve current user id)');
    return clean;
}

export async function extractNotesFromDom(page) {
    const payload = unwrapBrowserResult(await page.evaluate(EXTRACT_COLLECTION_DOM_JS));
    if (!Array.isArray(payload)) throw new CommandExecutionError('xiaohongshu collection DOM extraction returned malformed rows');
    return payload.filter((item) => item?.id);
}

export async function extractCollectionAlbumsFromDom(page) {
    const payload = unwrapBrowserResult(await page.evaluate(EXTRACT_COLLECTIONS_DOM_JS));
    if (!Array.isArray(payload)) throw new CommandExecutionError('xiaohongshu collection album DOM extraction returned malformed rows');
    return payload.filter((item) => item?.id && item?.name);
}

export function buildCollectionStateJs(profileTab, boardId = '', userId = '') {
    return `(() => {
      const unwrap = (value) => value?.value ?? value?._value ?? value;
      const state = window.__INITIAL_STATE__;
      const boardId = ${JSON.stringify(boardId)};
      let notes, hasMore;
      if (boardId) {
        const feed = unwrap(state?.board?.boardFeedsMap)?.[boardId];
        notes = feed?.notes;
        hasMore = feed?.hasMore;
      } else {
        const user = state?.user;
        const tab = unwrap(user?.activeTab);
        const subTab = unwrap(user?.activeSubTab);
        if (tab?.query !== ${JSON.stringify(profileTab)} || subTab?.query !== 'note') return null;
        const index = subTab.index;
        const query = unwrap(user?.noteQueries)?.[index];
        if (${JSON.stringify(userId)} && query?.userId !== ${JSON.stringify(userId)}) return null;
        notes = unwrap(user?.notes)?.[index];
        hasMore = query?.hasMore;
      }
      if (!Array.isArray(notes)) return null;
      return JSON.parse(JSON.stringify({ notes, hasMore }));
    })()`;
}

const EXTRACT_COLLECTIONS_STATE_JS = `(() => {
  const unwrap = (value) => value?.value ?? value?._value ?? value;
  const state = window.__INITIAL_STATE__;
  if (unwrap(state?.user?.activeTab)?.query !== 'fav' || unwrap(state?.user?.activeSubTab)?.query !== 'board') return null;
  const albums = unwrap(state?.board?.userBoardList);
  return Array.isArray(albums) ? JSON.parse(JSON.stringify(albums.map(({ id, name, total }) => ({
    id, name, count: String(total ?? ''), url: new URL('/board/' + encodeURIComponent(id), location.origin).toString()
  })))) : null;
})()`;

async function readCollectionState(page, profileTab, boardId, userId) {
    const state = unwrapBrowserResult(await page.evaluate(buildCollectionStateJs(profileTab, boardId, userId)));
    if (!isObject(state) || !Array.isArray(state.notes)) return null;
    return { notes: extractNotesFromResponses([{ data: { notes: state.notes } }]), hasMore: state.hasMore };
}

async function readCollectionAlbums(page) {
    const albums = unwrapBrowserResult(await page.evaluate(EXTRACT_COLLECTIONS_STATE_JS));
    return Array.isArray(albums) ? albums : extractCollectionAlbumsFromDom(page);
}

export async function resolveXhsCollection(page, userId, collectionName) {
    await page.goto(buildProfileCollectionUrl(userId, SAVED_PROFILE_TAB, ALBUM_PROFILE_SUBTAB));
    await page.wait(2);
    await assertOnCollectionProfile(page, userId);
    const albums = await readCollectionAlbums(page);
    const wanted = toCleanString(collectionName);
    const match = albums.find((album) => album.name === wanted);
    if (!match) {
        const available = albums.map((album) => album.name).join('、') || '无';
        throw new ArgumentError(`--collection ${JSON.stringify(wanted)} not found; available collections: ${available}`);
    }
    return match;
}

export async function fetchXhsCollectionNotes(page, { userId, profileTab, apiPattern, limit, emptyLabel, collection }) {
    const capturedRequests = [];
    let targetUrl = buildProfileCollectionUrl(userId, profileTab);
    let boardId = '';
    if (toCleanString(collection)) {
        const match = await resolveXhsCollection(page, userId, collection);
        boardId = match.id;
        targetUrl = buildCollectionBoardUrl(boardId);
    }
    await page.installInterceptor(apiPattern);
    await page.goto(targetUrl);
    await page.wait(2);
    if (boardId) await assertOnBoardPage(page, boardId);
    else await assertOnCollectionProfile(page, userId);
    let state = await readCollectionState(page, profileTab, boardId, userId);
    let notes = state?.notes ?? [];
    for (let i = 0; !notes.length && state?.hasMore !== false && i < 16; i++) {
        await page.wait(0.5);
        state = await readCollectionState(page, profileTab, boardId, userId);
        notes = state?.notes.length ? state.notes : await accumulateInterceptedNotes(page, capturedRequests, userId);
    }
    let previousCount = notes.length;
    for (let i = 0; notes.length < limit && state?.hasMore !== false && i < 4; i += 1) {
        await page.autoScroll({ times: 1, delayMs: 1500 });
        await page.wait(1);
        state = await readCollectionState(page, profileTab, boardId, userId);
        const captured = await accumulateInterceptedNotes(page, capturedRequests, userId);
        const nextNotes = [...new Map([...notes, ...(state?.notes ?? []), ...captured].map((note) => [note.id, note])).values()];
        if (nextNotes.length > previousCount) { notes = nextNotes; previousCount = nextNotes.length; continue; }
        break;
    }
    if (!notes.length) {
        const domNotes = await extractNotesFromDom(page);
        if (domNotes.length) notes = domNotes;
    }
    if (!notes.length && state?.hasMore !== false) throw new CommandExecutionError(`Xiaohongshu ${emptyLabel} list has not loaded; open the collection page in the browser and retry.`);
    return notes.slice(0, limit).map((item, index) => ({ rank: index + 1, ...item }));
}

export async function fetchXhsCollections(page, { userId, limit }) {
    await page.goto(buildProfileCollectionUrl(userId, SAVED_PROFILE_TAB, ALBUM_PROFILE_SUBTAB));
    await page.wait(2);
    await assertOnCollectionProfile(page, userId);
    const albums = await readCollectionAlbums(page);
    return albums.slice(0, limit).map((item, index) => ({ rank: index + 1, ...item }));
}
