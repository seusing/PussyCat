import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@jackwener/opencli/registry';
import {
  ALBUM_PROFILE_SUBTAB,
  EXTRACT_COLLECTION_DOM_JS,
  buildCollectionBoardUrl,
  buildProfileCollectionUrl,
  buildCollectionStateJs,
  fetchXhsCollectionNotes,
} from './collection-helpers.js';
import './collections.js';
import './saved.js';

const note = { noteId: '662908190000000001007366', xsecToken: 'token', displayTitle: '收藏笔记', user: { userId: 'author-1', nickName: '作者' } };
const profileLocation = { hostname: 'www.xiaohongshu.com', pathname: '/user/profile/user-1', href: 'https://www.xiaohongshu.com/user/profile/user-1' };

function collectionPage(state) {
  return {
    goto: vi.fn(), wait: vi.fn(), installInterceptor: vi.fn(), autoScroll: vi.fn(),
    getInterceptedRequests: vi.fn().mockResolvedValue([]),
    evaluate: vi.fn(async (script) => script.includes('let notes, hasMore') ? state
      : script.includes('location.href') ? profileLocation
        : script.includes('section.note-item') ? [] : false),
  };
}

describe('xiaohongshu read-only collection adapter', () => {
  it('builds the album profile and board URLs', () => {
    expect(buildProfileCollectionUrl('user-1', 'fav', ALBUM_PROFILE_SUBTAB))
      .toBe('https://www.xiaohongshu.com/user/profile/user-1?tab=fav&subTab=board');
    expect(buildCollectionBoardUrl('album-1')).toBe('https://www.xiaohongshu.com/board/album-1');
  });

  it('matches an album name exactly and reports available names', async () => {
    const page = {
      goto: async () => {},
      wait: async () => {},
      evaluate: async (script) => script.includes('a[href*="/board/"]')
        ? [{ id: 'a1', name: '旅行', count: '2', url: 'https://www.xiaohongshu.com/board/a1' }]
        : script.includes('location.href')
          ? { hostname: 'www.xiaohongshu.com', pathname: '/user/profile/user-1', href: 'https://www.xiaohongshu.com/user/profile/user-1' }
          : false,
    };
    const { resolveXhsCollection } = await import('./collection-helpers.js');
    await expect(resolveXhsCollection(page, 'user-1', '旅行')).resolves.toMatchObject({ id: 'a1' });
    await expect(resolveXhsCollection(page, 'user-1', '工作')).rejects.toBeInstanceOf(ArgumentError);
  });

  it('keeps board note URL extraction in the browser expression', () => {
    expect(EXTRACT_COLLECTION_DOM_JS).toContain('/board\\/[^/]+\\/([0-9a-f]{24})');
  });

  it('registers collections as a read-only command', () => {
    const command = getRegistry().get('xiaohongshu/collections');
    expect(command).toMatchObject({ name: 'collections', access: 'read', browser: true });
    expect(command.columns).toEqual(['rank', 'id', 'name', 'count', 'url']);
  });

  it('reads only the selected saved list from hydrated state before masonry is rendered', () => {
    const state = { user: {
      activeTab: { value: { query: 'fav' } },
      activeSubTab: { value: { query: 'note', index: 1 } },
      notes: { value: [[{ id: 'posted-note' }], [note], [{ id: 'liked-note' }]] },
      noteQueries: { value: [{}, { hasMore: false, userId: 'user-1' }] },
    } };
    expect(runInNewContext(buildCollectionStateJs('fav'), { window: { __INITIAL_STATE__: state } }))
      .toEqual({ notes: [note], hasMore: false });
    expect(runInNewContext(buildCollectionStateJs('liked'), { window: { __INITIAL_STATE__: state } })).toBeNull();
    expect(runInNewContext(buildCollectionStateJs('fav', '', 'other-user'), { window: { __INITIAL_STATE__: state } })).toBeNull();
  });

  it('reads liked notes and hasMore from the active top-level tab index', () => {
    const likedNote = { ...note, noteId: '662908190000000001007367', displayTitle: '点赞笔记' };
    const state = { user: {
      activeTab: { value: { query: 'liked', index: 2 } },
      activeSubTab: { value: { query: 'note', index: 1 } },
      notes: { value: [[{ id: 'posted-note' }], [note], [likedNote]] },
      noteQueries: { value: [{}, { hasMore: true, userId: 'user-1' }, { hasMore: false, userId: 'user-1' }] },
    } };
    expect(runInNewContext(buildCollectionStateJs('liked', '', 'user-1'), { window: { __INITIAL_STATE__: state } }))
      .toEqual({ notes: [likedNote], hasMore: false });
    state.user.activeSubTab = undefined;
    expect(runInNewContext(buildCollectionStateJs('liked', '', 'user-1'), { window: { __INITIAL_STATE__: state } }))
      .toEqual({ notes: [likedNote], hasMore: false });
  });

  it('returns hydrated saved notes without waiting for an XHR that SSR does not send', async () => {
    const page = collectionPage({ notes: [note], hasMore: false });
    await expect(fetchXhsCollectionNotes(page, { userId: 'user-1', profileTab: 'fav', apiPattern: 'note/collect/page', limit: 20, emptyLabel: 'saved' }))
      .resolves.toMatchObject([{ rank: 1, title: '收藏笔记', author: '作者', url: expect.stringContaining('xsec_token=token') }]);
    expect(page.getInterceptedRequests).not.toHaveBeenCalled();
    expect(page.autoScroll).not.toHaveBeenCalled();
  });

  it('returns hydrated liked notes without polling intercepts or scrolling', async () => {
    const likedNote = { ...note, displayTitle: '点赞笔记' };
    const page = collectionPage({ notes: [likedNote], hasMore: false });
    await expect(fetchXhsCollectionNotes(page, { userId: 'user-1', profileTab: 'liked', apiPattern: 'note/like/page', limit: 20, emptyLabel: 'liked' }))
      .resolves.toMatchObject([{ rank: 1, title: '点赞笔记', author: '作者', url: expect.stringContaining('xsec_token=token') }]);
    expect(page.getInterceptedRequests).not.toHaveBeenCalled();
    expect(page.autoScroll).not.toHaveBeenCalled();
  });

  it('prefers the visible cover link over an earlier hidden explore link', () => {
    const id = '662908190000000001007368';
    const dom = new JSDOM(`<section class="note-item">
      <a href="/explore/662908190000000001007369" hidden>hidden</a>
      <a class="cover mask" href="/explore/${id}?xsec_token=valid-token">cover</a>
      <span class="title">有效笔记</span><a class="author"><span class="name">作者</span></a><span class="count">7</span>
    </section>`, { url: 'https://www.xiaohongshu.com/user/profile/user-1' });
    expect(runInNewContext(EXTRACT_COLLECTION_DOM_JS, { document: dom.window.document, URL: dom.window.URL }))
      .toEqual([{ id, title: '有效笔记', author: '作者', likes: '7', type: '', url: `https://www.xiaohongshu.com/explore/${id}?xsec_token=valid-token` }]);
  });

  it('returns an empty list only when the loaded list has no more notes', async () => {
    const options = { userId: 'user-1', profileTab: 'fav', apiPattern: 'note/collect/page', limit: 20, emptyLabel: 'saved' };
    await expect(fetchXhsCollectionNotes(collectionPage({ notes: [], hasMore: false }), options)).resolves.toEqual([]);
    await expect(fetchXhsCollectionNotes(collectionPage(null), options)).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('reads the named board feed independently of the profile lists', () => {
    const state = { board: { boardFeedsMap: { value: { 'board-1': { notes: [note], hasMore: false } } } } };
    expect(runInNewContext(buildCollectionStateJs('fav', 'board-1'), { window: { __INITIAL_STATE__: state } }))
      .toEqual({ notes: [note], hasMore: false });
  });

  it('lists collection names through saved while keeping the collections command', async () => {
    const albums = [{ id: 'board-1', name: '旅行', count: '3', url: 'https://www.xiaohongshu.com/board/board-1' }];
    const page = collectionPage(null);
    page.evaluate.mockImplementation(async (script) => script.includes('userBoardList') ? albums
      : script.includes('location.href') ? profileLocation : false);
    const command = getRegistry().get('xiaohongshu/saved');
    expect(command.args).toContainEqual(expect.objectContaining({ name: 'list-collections', type: 'bool' }));
    await expect(command.func(page, { id: 'user-1', limit: 20, 'list-collections': true })).resolves.toEqual([{ rank: 1, ...albums[0] }]);
  });
});
