import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { buildApplySearchFiltersJs, buildSearchExtractJs, parseSearchFilters } from './search.js';

// 结构取自登录后的小红书搜索结果页（.filter-panel > .filters > span + .tag-container > .tags）。
const group = (label, options) => `<div class="filters"><span>${label}</span><div class="tag-container">${options
    .map((option, index) => `<div class="tags${index === 0 ? ' active' : ''}"><span>${option}</span></div>`).join('')}</div></div>`;
const PANEL = `<div class="filter-panel"><div class="filters-wrapper">${group('排序依据', ['综合', '最新', '最多点赞', '最多评论', '最多收藏'])}${group('笔记类型', ['不限', '视频', '图文'])}${group('发布时间', ['不限', '一天内', '一周内', '半年内'])}</div><div><span>重置</span><span>收起</span></div></div>`;

function searchPage({ withPanel }) {
    const dom = new JSDOM(`<body><div class="filter"><span>筛选</span></div>${withPanel ? PANEL : ''}<section class="note-item" data-note-id="n0"></section></body>`, { runScripts: 'outside-only' });
    const { document } = dom.window;
    document.querySelector('.filter').addEventListener('click', () => {
        document.body.insertAdjacentHTML('beforeend', PANEL);
        wireTags(document);
    });
    if (withPanel) wireTags(document);
    return dom;
}

function wireTags(document) {
    for (const tag of document.querySelectorAll('.filter-panel .tags')) {
        tag.addEventListener('click', () => {
            for (const sibling of tag.parentElement.children) sibling.classList.toggle('active', sibling === tag);
            document.querySelector('section.note-item').setAttribute('data-note-id', `after-${tag.textContent.trim()}`);
        });
    }
}

describe('xiaohongshu search filters', () => {
    it('keeps page defaults untouched and maps chosen options to the panel text', () => {
        expect(parseSearchFilters({})).toEqual([]);
        expect(parseSearchFilters({ sort: 'latest', type: 'video', time: 'week' })).toEqual([
            { group: '排序依据', option: '最新' },
            { group: '笔记类型', option: '视频' },
            { group: '发布时间', option: '一周内' },
        ]);
        expect(() => parseSearchFilters({ sort: 'hot' })).toThrow(ArgumentError);
    });

    it('opens the panel and clicks each option by its visible text', async () => {
        const dom = searchPage({ withPanel: false });
        const outcome = await dom.window.eval(buildApplySearchFiltersJs(parseSearchFilters({ sort: 'likes', time: 'day' })));
        expect(outcome).toEqual({ ok: true, active: ['最多点赞', '不限', '一天内'] });
    });

    it('reports a missing option instead of returning unfiltered results', async () => {
        const dom = searchPage({ withPanel: true });
        const outcome = await dom.window.eval(buildApplySearchFiltersJs([{ group: '发布时间', option: '三天内' }]));
        expect(outcome).toEqual({ ok: false, missing: '发布时间 / 三天内' });
    });

    it('marks video cards by their play icon', () => {
        const card = (id, video) => `<section class="note-item" data-note-id="${id}"><a class="cover mask" href="/search_result/${id}?xsec_token=t">${video ? '<span class="play-icon"></span>' : ''}</a><div class="footer"><a class="title"><span>标题${id}</span></a></div></section>`;
        const dom = new JSDOM(`<body>${card('aaaaaaaaaaaaaaaaaaaaaaaa', true)}${card('bbbbbbbbbbbbbbbbbbbbbbbb', false)}</body>`, { runScripts: 'outside-only' });
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 100 });
        const rows = dom.window.eval(buildSearchExtractJs('www.xiaohongshu.com'));
        expect(rows.map((row) => row.type)).toEqual(['video', 'normal']);
    });
});

describe('xiaohongshu search command', () => {
    it('declares the filter options and the type column', () => {
        const command = getRegistry().get('xiaohongshu/search');
        expect(command.args.map((arg) => arg.name)).toEqual(['query', 'limit', 'sort', 'time', 'type']);
        expect(command.columns).toEqual(['rank', 'title', 'author', 'likes', 'type', 'published_at', 'url']);
    });

    it('fails loudly when the filter panel cannot be used', async () => {
        const page = {
            goto: vi.fn(),
            evaluate: vi.fn(async (script) => (script.includes('MutationObserver') && script.includes('login_wall') ? 'content'
                : script.includes('filter-panel') ? { ok: false, missing: '筛选' } : [])),
        };
        await expect(getRegistry().get('xiaohongshu/search').func(page, { query: '咖啡', limit: 5, sort: 'latest' }))
            .rejects.toBeInstanceOf(CommandExecutionError);
    });
});
