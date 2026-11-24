import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { buildApplySearchFiltersJs, buildSearchExtractJs, parseSearchFilters } from './search.js';

// 结构取自登录后的小红书搜索结果页（.filter-panel > .filters > span + .tag-container > .tags）。
// decoys:国际版在每个选项前插一个文字相同、透明且点不了的诱饵;国际版的卡片也没有 data-note-id。
const DECOY_STYLE = 'position: absolute; opacity: 1e-05; pointer-events: none;';
const tags = (option, active, decoys) => {
    const cls = `tags${active ? ' active' : ''}`;
    const decoy = decoys ? `<div class="${cls}" aria-hidden="true" tabindex="-1" style="${DECOY_STYLE}"><span>${option}</span></div>` : '';
    return `${decoy}<div class="${cls}"><span>${option}</span></div>`;
};
const group = (label, options, decoys) => `<div class="filters"><span>${label}</span><div class="tag-container">${options
    .map((option, index) => tags(option, index === 0, decoys)).join('')}</div></div>`;
const panel = (decoys) => `<div class="filter-panel"><div class="filters-wrapper">${group('排序依据', ['综合', '最新', '最多点赞', '最多评论', '最多收藏'], decoys)}${group('笔记类型', ['不限', '视频', '图文'], decoys)}${group('发布时间', ['不限', '一天内', '一周内', '半年内'], decoys)}</div><div><span>重置</span><span>收起</span></div></div>`;
const card = (decoys) => (decoys
    ? '<section class="note-item"><a class="cover mask" href="/search_result/n0?xsec_token=t"></a></section>'
    : '<section class="note-item" data-note-id="n0"></section>');

function searchPage({ withPanel, decoys = false }) {
    const dom = new JSDOM(`<body><div class="filter"><span>筛选</span></div>${withPanel ? panel(decoys) : ''}${card(decoys)}</body>`, { runScripts: 'outside-only' });
    const { document } = dom.window;
    document.querySelector('.filter').addEventListener('click', () => {
        document.body.insertAdjacentHTML('beforeend', panel(decoys));
        wireTags(document);
    });
    if (withPanel) wireTags(document);
    return dom;
}

// 点到哪个选项,同组里与它同名的(真身和诱饵)一起变成 active,第一张卡片换掉
function wireTags(document) {
    for (const tag of document.querySelectorAll('.filter-panel .tags')) {
        tag.addEventListener('click', () => {
            for (const sibling of tag.parentElement.children) sibling.classList.toggle('active', sibling.textContent === tag.textContent);
            const first = document.querySelector('section.note-item');
            first.setAttribute('data-note-id', `after-${tag.textContent.trim()}`);
            first.querySelector('a')?.setAttribute('href', `/search_result/after-${tag.textContent.trim()}?xsec_token=t`);
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

    it('clicks the visible option, not the invisible decoy in front of it', async () => {
        const dom = searchPage({ withPanel: false, decoys: true });
        const decoyClicks = [];
        dom.window.document.body.addEventListener('click', (event) => {
            if (event.target.closest?.('[aria-hidden="true"]')) decoyClicks.push(event.target.textContent);
        }, true);
        const outcome = await dom.window.eval(buildApplySearchFiltersJs(parseSearchFilters({ sort: 'latest', type: 'video' })));
        expect(outcome).toEqual({ ok: true, active: ['最新', '视频', '不限'] });
        expect(decoyClicks).toEqual([]);
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

    it('searches on www.rednote.com for an international account and still writes www.xiaohongshu.com links', async () => {
        const page = {
            goto: vi.fn(),
            getCookies: vi.fn(async ({ url }) => (url.includes('rednote') ? [{ name: 'id_token', value: 'signed-in' }] : [])),
            evaluate: vi.fn(async (script) => (script.includes('MutationObserver') && script.includes('login_wall') ? 'content'
                : script.includes('const results = []') ? [{ title: '笔记', url: 'https://www.xiaohongshu.com/search_result/6a6a1379000000001f01c03c?xsec_token=T' }] : 1)),
        };
        const rows = await getRegistry().get('xiaohongshu/search').func(page, { query: '咖啡', limit: 1 });
        expect(page.goto).toHaveBeenCalledWith('https://www.rednote.com/search_result?keyword=%E5%92%96%E5%95%A1&source=web_search_result_notes');
        expect(page.evaluate.mock.calls.some(([script]) => script.includes("'https://www.xiaohongshu.com' + href"))).toBe(true);
        expect(rows).toMatchObject([{ rank: 1, url: 'https://www.xiaohongshu.com/search_result/6a6a1379000000001f01c03c?xsec_token=T' }]);
    });

    it('fails loudly when the filter panel cannot be used', async () => {
        const page = {
            goto: vi.fn(),
            getCookies: vi.fn(async () => []),
            evaluate: vi.fn(async (script) => (script.includes('MutationObserver') && script.includes('login_wall') ? 'content'
                : script.includes('filter-panel') ? { ok: false, missing: '筛选' } : [])),
        };
        await expect(getRegistry().get('xiaohongshu/search').func(page, { query: '咖啡', limit: 5, sort: 'latest' }))
            .rejects.toBeInstanceOf(CommandExecutionError);
    });
});
