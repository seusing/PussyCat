import { cli, Strategy } from '@jackwener/opencli/registry';
import { fetchXhsCollections, parseCollectionLimit, resolveXhsUserId } from './collection-helpers.js';

cli({
    site: 'xiaohongshu',
    name: 'collections',
    access: 'read',
    description: '列出小红书收藏专辑',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'id', type: 'string', help: 'User id or profile URL (defaults to current logged-in user)' },
        { name: 'limit', type: 'int', default: 100, help: 'Number of collections to return' },
    ],
    columns: ['rank', 'id', 'name', 'count', 'url'],
    func: async (page, kwargs) => {
        const limit = parseCollectionLimit(kwargs.limit);
        const userId = await resolveXhsUserId(page, kwargs.id);
        return fetchXhsCollections(page, { userId, limit });
    },
});
