import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import {
  ALBUM_PROFILE_SUBTAB,
  EXTRACT_COLLECTION_DOM_JS,
  buildCollectionBoardUrl,
  buildProfileCollectionUrl,
} from './collection-helpers.js';
import './collections.js';

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
});
