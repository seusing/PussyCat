// @vitest-environment node
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { DOT_PAGES, STOP_JS, askDot, clampTimeout, freshUrl, normalizeReferences } from './chat.js';

const HOSTS = { xiaohongshu: 'www.xiaohongshu.com', rednote: 'www.rednote.com' };

// 假的小红书网页:点点会话模块按两边实测的形状造,页面脚本在 vm 里真跑。
// - 国际版(rednote):store.rounds、createConversation(id)、会话对象 getLastRound / interruptCurrentMessage;
// - 大陆版(xiaohongshu):另有场景枚举、getSceneRounds、findConversationByConversationId、hasActiveStreamingRound。
// onPoll(n, round, env) 在第 n 次读回答状态前调用,用来模拟回答一段段到达。
function fakeSite({
    region = 'rednote', loggedIn = region, at = 'other', hasStore = true, pageAgeMs = 1000,
    onPoll = () => {}, references = [], referenceDelays = 0,
} = {}) {
    const mainland = region === 'xiaohongshu';
    const env = { rounds: [], active: null, pageLoadedAt: 0, clock: 10_000_000 };
    const lastRound = () => env.rounds[env.rounds.length - 1];
    let referenceCalls = 0;
    const makeConversation = (id) => ({
        getConversationId: () => id,
        getLastRound: lastRound,
        ...(mainland ? { hasActiveStreamingRound: () => !!lastRound() && !lastRound().aiMessage.isFinished } : {}),
        interruptCurrentMessage: vi.fn(() => {
            const round = lastRound();
            Object.assign(round, { isComplete: true });
            Object.assign(round.aiMessage, { isInterrupted: true, isFinished: true });
        }),
    });
    const makeStore = () => ({
        createConversation: vi.fn((id) => { env.active = makeConversation(id); }),
        clearConversation: vi.fn(() => { env.active = null; }),
        sendMessage: vi.fn(async (cid) => {
            if (!env.active || env.active.getConversationId() !== cid) return null;
            const msgId = `msg-${env.rounds.length + 1}`;
            env.rounds.push({ isComplete: false, aiMessage: { msgId, text: '', isFinished: false, dataFragments: [] } });
            return msgId;
        }),
        get activeConversation() { return env.active; },
        get rounds() { return env.rounds; },
        ...(mainland ? {
            getSceneRounds: (scene) => (scene === 'aiChat' ? env.rounds : []),
            switchScene: vi.fn(),
            findConversationByConversationId: (id) => (env.active && env.active.getConversationId() === id ? env.active : null),
        } : {}),
        agent: {
            getResponseReferences: vi.fn(async () => {
                referenceCalls += 1;
                return referenceCalls > referenceDelays
                    ? { items: references, baseInfo: { totalCnt: 'ai总结2篇笔记生成' } }
                    : { items: [], baseInfo: {} };
            }),
        },
    });
    let store = makeStore();
    const useStore = () => store;
    useStore.$id = 'conversation';
    const moduleExports = mainland ? { t: useStore, G: { AiChat: 'aiChat', Onebox: 'onebox' } } : { w: useStore };
    const req = () => moduleExports;
    req.m = hasStore ? { 61247: { toString: () => 'function(){ createConversation; sendMessage }' } } : {};
    const location = { hostname: 'www.example.com', pathname: '/', href: '' };
    const window = { webpackChunkxhs_pc_web: { push: ([, , callback]) => callback(req) } };
    const performance = { get timeOrigin() { return env.pageLoadedAt; } };
    let ids = 0;
    const context = vm.createContext({
        window, location, performance, crypto: { randomUUID: () => `conv-${++ids}` },
        Date: { now: () => env.clock },
    });
    const visit = (url) => {
        const target = new URL(url);
        const allowed = loggedIn === region || !target.pathname.startsWith('/ai_chat');
        location.hostname = target.hostname;
        location.pathname = allowed ? target.pathname : '/explore';
        env.pageLoadedAt = env.clock;
        // 刷新后页面里的会话对象、回合都没了
        env.active = null;
        env.rounds = [];
        delete window.__zzDot;
        store = makeStore();
    };
    if (at === 'dot') {
        visit(DOT_PAGES[region].url);
        env.pageLoadedAt = env.clock - pageAgeMs;
    }
    let polls = 0;
    const page = {
        evaluate: vi.fn(async (js) => {
            if (js.includes('stopRequested: !!dot.stopRequested,')) {
                polls += 1;
                onPoll(polls, lastRound(), { window, location, env });
            }
            return vm.runInContext(js, context);
        }),
        goto: vi.fn(async (url) => visit(url)),
        wait: vi.fn(async () => {}),
        getCookies: vi.fn(async ({ url }) => {
            const host = new URL(url).hostname;
            const regionOfUrl = host.endsWith('rednote.com') ? 'rednote' : 'xiaohongshu';
            return loggedIn === regionOfUrl ? [{ name: 'id_token', value: 'token' }] : [];
        }),
    };
    return { page, env, location, window, store: () => store, reload: () => visit(DOT_PAGES[region].url) };
}

// 每次轮询往正文末尾追加一段,最后一次标完成
const streamOf = (parts, extra = {}) => (n, round) => {
    if (!round) return;
    if (n <= parts.length) round.aiMessage.text += parts[n - 1];
    if (n === parts.length) Object.assign(round.aiMessage, { isFinished: true, ...extra });
};
const answerAtOnce = (n, round) => {
    if (round && !round.aiMessage.isFinished) Object.assign(round.aiMessage, { text: '答', isFinished: true });
};

const run = (page, kwargs, options = {}) => {
    const events = [];
    const promise = askDot(page, { timeout: 180, ...kwargs }, {
        emit: (event) => events.push(event), pollMs: 0, settleMs: 0, referenceRetryMs: 0, ...options,
    });
    return { events, promise };
};

const REFERENCE = {
    id: '6a6df95f0000000026037a07', title: '剪辑必学三大核心功能', noteType: 'video', nickName: '剪辑小王',
    content: '画中画、关键帧、蒙版一次讲透', originLocation: [0, 14],
    textLink: 'xhsdiscover://item/6a6df95f0000000026037a07?type=normal',
};

describe('askDot', () => {
    it('国际版:打开发现页,在会话模块里发问,把过程、正文增量、引用和结束写成事件', async () => {
        const site = fakeSite({
            references: [REFERENCE],
            onPoll: (n, round) => {
                if (!round) return;
                round.aiMessage.thinkProgress = n === 1
                    ? [{ progressStatus: 1, progressText: '问题分析中' }, { progressStatus: 0, progressText: '搜索相关内容' }]
                    : [{ progressStatus: 1, progressText: '问题分析中' }, { progressStatus: 2, progressText: '搜索完成' }];
                streamOf(['剪辑', '技巧'])(n, round);
            },
        });
        const { events, promise } = run(site.page, { query: '推荐剪辑视频' });
        const rows = await promise;

        expect(site.page.goto).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/www\.rednote\.com\/explore\?_zz=\d+$/));
        expect(site.store().createConversation).toHaveBeenCalledWith('conv-1', undefined);
        expect(events).toEqual([
            { type: 'start', conversationId: 'conv-1', messageId: 'msg-1', region: 'rednote' },
            { type: 'status', text: '问题分析中' },
            { type: 'delta', text: '剪辑' },
            { type: 'status', text: '搜索完成' },
            { type: 'delta', text: '技巧' },
            { type: 'references', items: [{
                noteId: REFERENCE.id, title: '剪辑必学三大核心功能', author: '剪辑小王', noteType: 'video',
                url: `https://www.xiaohongshu.com/explore/${REFERENCE.id}`, quote: '画中画、关键帧、蒙版一次讲透',
            }] },
            { type: 'done', sourceTotal: 'ai总结2篇笔记生成', interrupted: false },
        ]);
        expect(rows).toEqual([{
            answer: '剪辑技巧', source_total_text: 'ai总结2篇笔记生成', source_count: 1,
            conversation_id: 'conv-1', message_id: 'msg-1',
        }]);
    });

    it('大陆版:用点点页 /ai_chat,按场景建会话、读回合', async () => {
        const site = fakeSite({ region: 'xiaohongshu', onPoll: streamOf(['你好']) });
        const { events, promise } = run(site.page, { query: '问' });
        await promise;
        expect(site.page.goto).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/www\.xiaohongshu\.com\/ai_chat\?_zz=\d+$/));
        expect(site.store().switchScene).toHaveBeenCalledWith('aiChat');
        expect(site.store().createConversation).toHaveBeenCalledWith('conv-1', 'aiChat');
        expect(events[0]).toMatchObject({ type: 'start', region: 'xiaohongshu' });
        expect(events).toContainEqual({ type: 'delta', text: '你好' });
    });

    it('两边都登录时用大陆版', async () => {
        const site = fakeSite({ region: 'xiaohongshu', onPoll: answerAtOnce });
        site.page.getCookies.mockResolvedValue([{ name: 'id_token', value: 'token' }]);
        await run(site.page, { query: '问' }).promise;
        expect(site.page.goto).toHaveBeenCalledWith(expect.stringContaining(DOT_PAGES.xiaohongshu.url));
    });

    it('已在点点页面且页面不旧:不重新打开,同一会话里接着问', async () => {
        const site = fakeSite({ at: 'dot', onPoll: answerAtOnce });
        await run(site.page, { query: '第一问' }).promise;
        const { events, promise } = run(site.page, { query: '再看看', conversation: 'conv-1' });
        await promise;
        expect(site.page.goto).not.toHaveBeenCalled();
        expect(site.store().createConversation).toHaveBeenCalledTimes(1);
        expect(site.store().sendMessage).toHaveBeenLastCalledWith('conv-1', '再看看', expect.anything());
        expect(events[0]).toMatchObject({ type: 'start', conversationId: 'conv-1' });
    });

    it('页面被刷新过(会话对象没了):用同一个会话 id 重建,点点那边接着上下文', async () => {
        const site = fakeSite({ at: 'dot', onPoll: answerAtOnce });
        await run(site.page, { query: '第一问' }).promise;
        site.reload();
        const { events, promise } = run(site.page, { query: '追问', conversation: 'conv-1' });
        await promise;
        expect(site.store().createConversation).toHaveBeenCalledWith('conv-1', undefined);
        expect(events[0]).toMatchObject({ type: 'start', conversationId: 'conv-1' });
    });

    it('页面在后台放久了:先刷新再问', async () => {
        const site = fakeSite({ at: 'dot', pageAgeMs: 5 * 60 * 1000, onPoll: answerAtOnce });
        await run(site.page, { query: '问' }).promise;
        expect(site.page.goto).toHaveBeenCalledWith(expect.stringContaining(DOT_PAGES.rednote.url));
    });

    it('两边都没登录:直接报需要登录,不打开页面', async () => {
        const site = fakeSite({ loggedIn: null });
        const { events, promise } = run(site.page, { query: '问' });
        await expect(promise).rejects.toBeInstanceOf(AuthRequiredError);
        expect(site.page.goto).not.toHaveBeenCalled();
        expect(events).toEqual([{ type: 'error', message: expect.stringContaining('要先在 Chrome 里登录小红书') }]);
    });

    it('大陆站点点页被跳回发现页(有的账号会这样):照样在发现页里问', async () => {
        const site = fakeSite({ region: 'xiaohongshu', onPoll: answerAtOnce });
        const visit = site.page.goto.getMockImplementation();
        site.page.goto.mockImplementation(async (url) => {
            await visit(url);
            site.location.pathname = '/explore';
        });
        const { events, promise } = run(site.page, { query: '问' });
        await promise;
        expect(events[0]).toMatchObject({ type: 'start', region: 'xiaohongshu' });
    });

    it('标签停在网络错误页:带新参数强制重新打开;还是打不开就报网络问题,不说成没登录', async () => {
        const site = fakeSite({ region: 'xiaohongshu' });
        site.location.hostname = '';
        site.page.goto.mockImplementation(async () => {
            site.location.hostname = '';
            site.location.href = 'chrome-error://chromewebdata/';
        });
        const { events, promise } = run(site.page, { query: '问' });
        await expect(promise).rejects.toThrow('打不开小红书网页');
        await expect(promise).rejects.toBeInstanceOf(CommandExecutionError);
        // 原因写进事件流,对话窗口直接显示
        expect(events).toEqual([{ type: 'error', message: '打不开小红书网页：检查网络或代理后重试' }]);
    });

    it('打开后被跳到别的站点(登录失效):报需要登录', async () => {
        const site = fakeSite({ region: 'xiaohongshu' });
        site.page.goto.mockImplementation(async () => {
            site.location.hostname = 'passport.example.com';
            site.location.pathname = '/login';
        });
        await expect(run(site.page, { query: '问' }).promise).rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('页面里找不到会话模块:报点点页面改版', async () => {
        const site = fakeSite({ hasStore: false });
        await expect(run(site.page, { query: '问' }).promise).rejects.toThrow('点点页面改版了');
    });

    it('正文被整段改写时发 replace,不按末尾增量算', async () => {
        const site = fakeSite({
            onPoll: (n, round) => {
                if (n === 1) round.aiMessage.text = '草稿';
                if (n === 2) Object.assign(round.aiMessage, { text: '定稿内容', isFinished: true });
            },
        });
        const { events, promise } = run(site.page, { query: '问' });
        await promise;
        expect(events.filter((event) => event.type === 'delta' || event.type === 'replace')).toEqual([
            { type: 'delta', text: '草稿' },
            { type: 'replace', text: '定稿内容' },
        ]);
    });

    it('正文还没合成到 text 时按片段拼', async () => {
        const site = fakeSite({
            onPoll: (n, round) => {
                round.aiMessage.dataFragments = [{ fragmentType: 9, text: '' }, { fragmentType: 1, text: '片段一' }, { fragmentType: 1, text: '片段二' }];
                if (n === 2) Object.assign(round.aiMessage, { text: '片段一片段二', isFinished: true });
            },
        });
        const { events, promise } = run(site.page, { query: '问' });
        const rows = await promise;
        expect(events.filter((event) => event.type === 'delta')).toEqual([{ type: 'delta', text: '片段一片段二' }]);
        expect(rows[0].answer).toBe('片段一片段二');
    });

    it('停止:点点自己的停止被调用,chat 收尾结束,不再取引用', async () => {
        const site = fakeSite({ onPoll: (n, round) => { if (n === 1) round.aiMessage.text = '答了一半'; } });
        const original = site.page.evaluate.getMockImplementation();
        let polled = 0;
        site.page.evaluate.mockImplementation(async (js) => {
            if (js.includes('stopRequested: !!dot.stopRequested,') && ++polled === 2) await original(STOP_JS);
            return original(js);
        });
        const { events, promise } = run(site.page, { query: '长问题' });
        const rows = await promise;
        expect(site.env.active.interruptCurrentMessage).toHaveBeenCalledTimes(1);
        expect(site.store().agent.getResponseReferences).not.toHaveBeenCalled();
        expect(events.at(-1)).toEqual({ type: 'done', sourceTotal: '', interrupted: true });
        expect(rows[0].answer).toBe('答了一半');
    });

    it('回答还没出现就被停止,也能收尾', async () => {
        const site = fakeSite({ onPoll: () => {} });
        const original = site.page.evaluate.getMockImplementation();
        let polled = 0;
        site.page.evaluate.mockImplementation(async (js) => {
            if (js.includes('stopRequested: !!dot.stopRequested,') && ++polled === 1) {
                site.env.rounds.length = 0; // 回答这一轮还没回来
                await original(STOP_JS);
            }
            return original(js);
        });
        const { events, promise } = run(site.page, { query: '问' });
        await promise;
        expect(events.at(-1)).toMatchObject({ type: 'done', interrupted: true });
    });

    it('页面被刷新(会话模块状态没了):报回答中断', async () => {
        const site = fakeSite({
            onPoll: (n, round, { window }) => {
                if (n === 1) round.aiMessage.text = '前半';
                if (n === 2) delete window.__zzDot;
            },
        });
        const { events, promise } = run(site.page, { query: '问' });
        await expect(promise).rejects.toBeInstanceOf(CommandExecutionError);
        expect(events.at(-1)).toEqual({ type: 'error', message: '点点页面被刷新，这条回答中断了' });
    });

    it('这一轮失败(超时、发送失败):报点点给的原因', async () => {
        const site = fakeSite({
            onPoll: (n, round) => Object.assign(round.aiMessage, { isFinished: true, isTimeout: true, errorReason: '服务繁忙' }),
        });
        const { events, promise } = run(site.page, { query: '问' });
        await expect(promise).rejects.toThrow('服务繁忙');
        expect(events.at(-1)).toEqual({ type: 'error', message: '服务繁忙' });
    });

    it('限定时间内没答完:报超时', async () => {
        let clock = 0;
        const site = fakeSite({ onPoll: () => { clock += 60_000; } });
        const { events, promise } = run(site.page, { query: '问', timeout: 120 }, { now: () => clock });
        await expect(promise).rejects.toBeInstanceOf(TimeoutError);
        expect(events.at(-1)).toEqual({ type: 'error', message: '点点在限定时间内没有答完' });
    });

    it('点点直接读了笔记(没有引用、只给出处说明):不再重取,出处照常带出', async () => {
        const site = fakeSite({ references: [], onPoll: answerAtOnce });
        const { events, promise } = run(site.page, { query: '总结这条小红书视频笔记讲了什么:https://www.xiaohongshu.com/explore/69bbe9d8000000001a02e786' });
        const rows = await promise;
        expect(site.store().agent.getResponseReferences).toHaveBeenCalledTimes(1);
        expect(events.at(-1)).toEqual({ type: 'done', sourceTotal: 'ai总结2篇笔记生成', interrupted: false });
        expect(rows[0]).toMatchObject({ source_total_text: 'ai总结2篇笔记生成', source_count: 0 });
    });

    it('点点给了「接着问」:随结束事件带出,字符串和对象条目都认,去重、最多 4 条', async () => {
        const site = fakeSite({
            references: [],
            onPoll: (n, round) => {
                if (!round || round.aiMessage.isFinished) return;
                round.aiMessage.dataFragments = [
                    { fragmentType: 1, text: '答' },
                    { fragmentType: 4, text: '', recommendTextList: ['肇庆怎么玩', { text: '清远有什么好吃的' }, '肇庆怎么玩', { content: ' 顺德一日游 ' }, '惠州', '珠海'] },
                ];
                Object.assign(round.aiMessage, { text: '答', isFinished: true });
            },
        });
        const { events, promise } = run(site.page, { query: '周末去哪' });
        await promise;
        expect(events.at(-1)).toEqual({
            type: 'done', sourceTotal: 'ai总结2篇笔记生成', interrupted: false,
            followUps: ['肇庆怎么玩', '清远有什么好吃的', '顺德一日游', '惠州'],
        });
    });

    it('「接着问」在正文结束后才补上:取完引用再看一眼', async () => {
        const site = fakeSite({
            references: [],
            onPoll: (n, round) => {
                if (!round) return;
                if (!round.aiMessage.isFinished) {
                    Object.assign(round.aiMessage, { text: '答', isFinished: true });
                    return;
                }
                round.aiMessage.dataFragments = [{ fragmentType: 4, recommendTextList: ['再推荐几个'] }];
            },
        });
        const { events, promise } = run(site.page, { query: '周末去哪' });
        await promise;
        expect(events.at(-1)).toMatchObject({ type: 'done', followUps: ['再推荐几个'] });
    });

    it('引用晚到:隔一会儿再取,取到就停', async () => {
        const site = fakeSite({ references: [REFERENCE], referenceDelays: 1, onPoll: answerAtOnce });
        const { events, promise } = run(site.page, { query: '问' });
        await promise;
        expect(site.store().agent.getResponseReferences).toHaveBeenCalledTimes(2);
        expect(events.filter((event) => event.type === 'references')).toHaveLength(1);
    });

    it('问题为空:参数错误', async () => {
        const site = fakeSite();
        await expect(run(site.page, { query: '   ' }).promise).rejects.toThrow('query is required');
    });
});

describe('STOP_JS', () => {
    it('没有在生成的回答时只留记号', async () => {
        const site = fakeSite({ at: 'dot' });
        site.store().createConversation('c');
        await expect(site.page.evaluate(STOP_JS)).resolves.toEqual({ stopped: true, interrupted: false });
        expect(site.env.active.interruptCurrentMessage).not.toHaveBeenCalled();
    });

    it('不在点点页面时什么也不做', async () => {
        const site = fakeSite();
        await expect(site.page.evaluate(STOP_JS)).resolves.toEqual({ stopped: false });
    });
});

describe('normalizeReferences / clampTimeout', () => {
    it('笔记 id 取字段或链接,链接带上 xsec_token;认不出 id 的丢掉', () => {
        expect(normalizeReferences([
            { id: '', title: 'A', noteType: 'normal', author: 'x', content: '', links: ['https://www.xiaohongshu.com/explore/69bbe9d8000000001a02e787?xsec_token=T%3D'] },
            { id: 'nope', title: 'B', links: [] },
        ])).toEqual([{
            noteId: '69bbe9d8000000001a02e787', title: 'A', author: 'x', noteType: 'normal',
            url: 'https://www.xiaohongshu.com/explore/69bbe9d8000000001a02e787?xsec_token=T%3D&xsec_source=pc_search', quote: '',
        }]);
        expect(normalizeReferences(undefined)).toEqual([]);
    });

    it('超时取整并封顶 180 秒', () => {
        expect(clampTimeout(30.7)).toBe(30);
        expect(clampTimeout(999)).toBe(180);
        expect(clampTimeout('x')).toBe(180);
    });

    it('打开地址每次都带新参数,原有参数保留', () => {
        expect(freshUrl('https://www.rednote.com/explore', 42)).toBe('https://www.rednote.com/explore?_zz=42');
        expect(freshUrl('https://www.xiaohongshu.com/ai_chat?a=1', 7)).toBe('https://www.xiaohongshu.com/ai_chat?a=1&_zz=7');
    });

    it('两个地区的点点页面', () => {
        expect(Object.keys(DOT_PAGES)).toEqual(Object.keys(HOSTS));
        for (const [region, host] of Object.entries(HOSTS)) expect(new URL(DOT_PAGES[region].url).hostname).toBe(host);
    });
});
