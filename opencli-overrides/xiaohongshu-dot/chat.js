import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { XHS_REGIONS, xhsIdToken } from '../xiaohongshu/region.js';

// 爪爪原生:在小红书网页里问点点,把回答一段段推给爪爪的对话窗口。
// 请求全由网页自己发(长连接 + HTTP 兜底,签名由页面自己的 JS 生成);这里只调页面里点点会话模块的方法、
// 读它的状态,不碰网络层。大陆版和国际版(rednote)都有这个模块,账号登在哪边就用哪边。
// 进度走 stderr:一行一个事件,前缀 EVENT_PREFIX,宿主逐行实时转给前端;最终结果照常走 stdout。
//
// 站点 key 单独用 xiaohongshu-dot:浏览器会话名是 site:<站点>,和别的小红书命令共用标签的话,
// 定时登录检查会把点点页面跳走。
// 页面里不用定时器:点点标签在后台窗口,浏览器会把后台页面的定时器大幅降速;轮询、重试都在这边做。

export const EVENT_PREFIX = '@@zz-dot ';
export const MAX_TIMEOUT_SECONDS = 180;
const POLL_MS = 150;
// 自己的超时要早于 opencli 按 timeout 参数掐断整条命令,好把原因写进事件流
const DEADLINE_MARGIN_MS = 3000;
// 后台页面放久了(Chrome 对隐藏超过 5 分钟的页面再加一档节流)回答会被拖慢:超过这个时长先刷新再问。
// 对话上下文存在点点那边,按会话 id 接续,刷新不丢。
const MAX_PAGE_AGE_MS = 4 * 60 * 1000;
const LOCATE_ATTEMPTS = 8;
const NOT_LOGGED_IN = '要先在 Chrome 里登录小红书（大陆站 xiaohongshu.com 或国际版 rednote.com 都可以）';

// 各地区在哪个页面里用点点:大陆站有专门的点点页 /ai_chat;国际版的点点挂在 AI 搜索上,
// 它的会话模块在发现页就已加载(/search_result_ai 一打开就会拿地址里的关键词自动发问,不用它)。
export const DOT_PAGES = {
    xiaohongshu: { url: 'https://www.xiaohongshu.com/ai_chat', host: 'www.xiaohongshu.com', path: '/ai_chat' },
    rednote: { url: 'https://www.rednote.com/explore', host: 'www.rednote.com', path: '/' },
};

export function emitEvent(event, write = (line) => process.stderr.write(line)) {
    write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`);
}

export function clampTimeout(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.floor(seconds), MAX_TIMEOUT_SECONDS) : MAX_TIMEOUT_SECONDS;
}

// 页面里共用的几个函数:找点点会话模块、读这一轮、停掉没结束的一轮
const PAGE_HELPERS = `
  const DOT_PAGES = ${JSON.stringify(Object.values(DOT_PAGES).map(({ host, path }) => ({ host, path })))};
  const onDotPage = () => DOT_PAGES.some((page) => location.hostname === page.host && location.pathname.startsWith(page.path));
  const unref = (value) => (value && value.value !== undefined ? value.value : value);
  const locate = () => {
    if (window.__zzDot && window.__zzDot.store) return window.__zzDot;
    const chunk = window.webpackChunkxhs_pc_web;
    if (!chunk) return null;
    let req;
    chunk.push([[Date.now()], {}, (r) => { req = r; }]);
    if (!req) return null;
    // 按模块「是什么」认,不写死模块号和导出名:每次发版模块号都会变,大陆版和国际版的导出名也不同。
    // 会话 store 是 Pinia 的 useStore(带 $id === 'conversation');大陆版另外导出场景枚举(含 AiChat)。
    for (const id of Object.keys(req.m || {})) {
      let source = '';
      try { source = req.m[id].toString(); } catch { continue; }
      if (!source.includes('createConversation') || !source.includes('sendMessage')) continue;
      let mod;
      try { mod = req(id); } catch { continue; }
      let useStore = null;
      let scenes = null;
      for (const value of Object.values(mod || {})) {
        if (typeof value === 'function' && value.$id === 'conversation') useStore = value;
        if (value && typeof value === 'object' && typeof value.AiChat === 'string') scenes = value;
      }
      if (!useStore) continue;
      const store = useStore();
      if (typeof store.createConversation !== 'function' || typeof store.sendMessage !== 'function') continue;
      window.__zzDot = { store, scene: scenes ? scenes.AiChat : undefined, texts: {}, stopRequested: 0 };
      return window.__zzDot;
    }
    return null;
  };
  const conversationOf = (store) => unref(store.activeConversation) || null;
  const roundsOf = (dot) => (dot.scene && typeof dot.store.getSceneRounds === 'function'
    ? dot.store.getSceneRounds(dot.scene) : unref(dot.store.rounds)) || [];
  // 有没有还在生成的一轮:大陆版会话对象自带判断,国际版看最后一轮
  const isStreaming = (conversation) => {
    if (typeof conversation.hasActiveStreamingRound === 'function') return conversation.hasActiveStreamingRound();
    const round = typeof conversation.getLastRound === 'function' ? conversation.getLastRound() : null;
    return !!(round && !round.isComplete && round.aiMessage && !round.aiMessage.isFinished);
  };
  // 点点自己的「停止生成」:会话对象上的 interruptCurrentMessage
  const interruptActive = (store) => {
    const conversation = conversationOf(store);
    if (!conversation || typeof conversation.interruptCurrentMessage !== 'function' || !isStreaming(conversation)) return false;
    conversation.interruptCurrentMessage();
    return true;
  };
`;

// 当前标签是不是该地区的点点页面、模块找不找得到、页面开了多久
export function buildLocateJs(region) {
    const { host, path } = DOT_PAGES[region];
    return `(() => {
  ${PAGE_HELPERS}
  if (location.hostname !== ${JSON.stringify(host)} || !location.pathname.startsWith(${JSON.stringify(path)})) {
    return { ok: false, error: 'not_on_page', href: location.href };
  }
  const age = Date.now() - performance.timeOrigin;
  return locate() ? { ok: true, age } : { ok: false, error: 'store_missing', age };
})()`;
}

export function buildSendJs(prompt, conversationId) {
    return `(async () => {
  ${PAGE_HELPERS}
  const dot = locate();
  if (!dot) return { ok: false, error: 'store_missing' };
  const { store, scene } = dot;
  const prompt = ${JSON.stringify(String(prompt))};
  const wanted = ${JSON.stringify(String(conversationId || ''))};
  dot.stopRequested = 0;
  // 上一轮没结束(上次被停止、或爪爪那边中途退出):先用点点自己的停止收掉
  try { interruptActive(store); } catch { /* 没有在生成的回答 */ }
  if (scene && typeof store.switchScene === 'function') store.switchScene(scene);
  const active = conversationOf(store);
  const current = active && typeof active.getConversationId === 'function' ? active.getConversationId() : '';
  const inPage = !!wanted && (current === wanted
    || (typeof store.findConversationByConversationId === 'function' && !!store.findConversationByConversationId(wanted)));
  if (!inPage) {
    // 新对话;或者页面刷新过、会话对象没了:用同一个 id 重建,点点那边按 id 接着之前的上下文
    if (typeof store.clearConversation === 'function') await Promise.resolve(store.clearConversation(scene));
    store.createConversation(wanted || crypto.randomUUID(), scene);
  }
  const conversation = conversationOf(store);
  const conversationIdNow = (conversation && typeof conversation.getConversationId === 'function' && conversation.getConversationId()) || wanted;
  const messageId = await store.sendMessage(conversationIdNow, prompt, { skipImmediateUI: true, skipHistory: true, visible: false });
  if (!messageId) return { ok: false, error: 'send_failed' };
  return { ok: true, conversationId: conversationIdNow, messageId: String(messageId) };
})()`;
}

// 读这一轮回答的当前状态。正文按上次读到的内容算增量;正文被整体改写(不是在末尾追加)时整段重发。
export function buildSnapshotJs(messageId) {
    return `(() => {
  ${PAGE_HELPERS}
  const dot = window.__zzDot;
  if (!dot || !onDotPage()) return { lost: true };
  const mid = ${JSON.stringify(String(messageId))};
  const round = [...roundsOf(dot)].reverse().find((r) => r && r.aiMessage && r.aiMessage.msgId === mid);
  if (!round) return { pending: true, stopRequested: !!dot.stopRequested };
  const ai = round.aiMessage;
  const fragments = Array.isArray(ai.dataFragments) ? ai.dataFragments : [];
  const text = String(ai.text || fragments.map((f) => (f && typeof f.text === 'string' ? f.text : '')).join(''));
  const previous = dot.texts[mid] || '';
  dot.texts[mid] = text;
  const appended = text.startsWith(previous);
  // 过程:thinkProgress 每一步 { progressStatus: 0 未开始 / 1 进行中 / 2 完成, progressText }
  const steps = (Array.isArray(ai.thinkProgress) ? ai.thinkProgress : [])
    .filter((step) => step && Number(step.progressStatus) > 0)
    .map((step) => String(step.progressText || ''))
    .filter(Boolean);
  return {
    delta: appended ? text.slice(previous.length) : '',
    replace: appended ? null : text,
    steps,
    finished: !!ai.isFinished,
    interrupted: !!ai.isInterrupted,
    failed: !!(ai.isTimeout || ai.isSendFailed),
    errorReason: String(ai.errorReason || ''),
    querySource: String((ai.querySource && (ai.querySource.text || ai.querySource.oneboxText)) || ''),
    stopRequested: !!dot.stopRequested,
  };
})()`;
}

// 取一次引用(没取到由调用方隔一会儿再取,页面里不等)
export function buildReferencesJs(prompt, messageId, size = 10) {
    return `(async () => {
  ${PAGE_HELPERS}
  const dot = window.__zzDot;
  const agent = dot && dot.store && unref(dot.store.agent);
  if (!agent || typeof agent.getResponseReferences !== 'function') return { items: [] };
  let detail = null;
  try {
    detail = await agent.getResponseReferences({
      query: ${JSON.stringify(String(prompt))},
      message_id: ${JSON.stringify(String(messageId))},
      page: 0, size: ${Number(size)}, version: 0, result_version: 0, id: '',
    });
  } catch { detail = null; }
  const items = detail && Array.isArray(detail.items) ? detail.items : [];
  return {
    total: String((detail && detail.baseInfo && detail.baseInfo.totalCnt) || ''),
    items: items.slice(0, ${Number(size)}).map((item) => ({
      id: item.id || item.noteId || item.note_id || '',
      title: item.title || item.displayTitle || '',
      noteType: item.noteType || '',
      author: item.nickName || item.nickname || '',
      content: String(item.content || '').slice(0, 2000),
      originLocation: item.originLocation || null,
      links: [item.textLink, item.link, item.url].filter(Boolean).map(String),
    })),
  };
})()`;
}

// 停止:先调点点自己的停止生成,再留个记号让正在轮询的 chat 收尾退出(哪怕回答还没开始出字)
export const STOP_JS = `(() => {
  ${PAGE_HELPERS}
  if (!onDotPage()) return { stopped: false };
  const dot = locate();
  if (!dot) return { stopped: false };
  dot.stopRequested = Date.now();
  let interrupted = false;
  try { interrupted = interruptActive(dot.store); } catch { /* 没有在生成的回答 */ }
  return { stopped: true, interrupted };
})()`;

const NOTE_ID = /^[0-9a-f]{24}$/i;

function xsecTokenOf(links) {
    for (const link of links) {
        const match = /[?&]xsec_?[tT]oken=([^&#]+)/.exec(link);
        if (match) return decodeURIComponent(match[1]);
    }
    return '';
}

function quoteOf(item) {
    const content = String(item.content || '').replace(/\s+/g, ' ').trim();
    const [start, length] = Array.isArray(item.originLocation) ? item.originLocation.map(Number) : [];
    if (Number.isInteger(start) && start >= 0 && Number.isInteger(length) && length > 0) {
        return content.slice(start, start + length).slice(0, 300);
    }
    return content.slice(0, 300);
}

// 页面给的引用 → 爪爪的卡片数据。链接一律写成 www.xiaohongshu.com/explore/<id>(与别的小红书命令一致),
// 有 xsec_token 就带上;国际版给的引用链接不带它,点点解析按笔记 id 读,不受影响。
export function normalizeReferences(items) {
    return (Array.isArray(items) ? items : [])
        .map((item) => {
            const links = Array.isArray(item.links) ? item.links : [];
            const fromLink = links.map((link) => /(?:item|explore|note)\/([0-9a-f]{24})/i.exec(link)?.[1]).find(Boolean);
            const noteId = NOTE_ID.test(String(item.id)) ? String(item.id) : (fromLink || '');
            if (!noteId) return null;
            const token = xsecTokenOf(links);
            const url = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
            if (token) {
                url.searchParams.set('xsec_token', token);
                url.searchParams.set('xsec_source', 'pc_search');
            }
            return {
                noteId,
                title: String(item.title || '').trim(),
                author: String(item.author || '').trim(),
                noteType: item.noteType === 'video' ? 'video' : item.noteType ? 'normal' : '',
                url: url.toString(),
                quote: quoteOf(item),
            };
        })
        .filter(Boolean);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 有的 opencli 版本把页面返回值包成 { session, data }
async function evaluateIn(page, js) {
    const payload = await page.evaluate(js);
    return payload && typeof payload === 'object' && !Array.isArray(payload) && 'session' in payload && 'data' in payload ? payload.data : payload;
}

/** 账号登在哪边就用哪边;都没登录返回 null。 */
export async function dotRegion(page) {
    for (const region of XHS_REGIONS) {
        if (await xhsIdToken(page, region)) return region.region;
    }
    return null;
}

/** 确保标签停在该地区的点点页面上、找得到会话模块;页面放久了先刷新。 */
async function openDotPage(page, region, { settleMs }) {
    let located = await evaluateIn(page, buildLocateJs(region)).catch(() => null);
    if (located?.ok && located.age < MAX_PAGE_AGE_MS) return;
    await page.goto(DOT_PAGES[region].url);
    for (let attempt = 0; attempt < LOCATE_ATTEMPTS; attempt += 1) {
        await sleep(settleMs);
        located = await evaluateIn(page, buildLocateJs(region)).catch(() => null);
        if (located?.ok || located?.error === 'not_on_page') break;
    }
    if (located?.ok) return;
    // 被跳去登录页、首页之类:登录失效了
    if (located?.error === 'not_on_page') throw new AuthRequiredError(DOT_PAGES[region].host, NOT_LOGGED_IN);
    throw new CommandExecutionError('点点页面改版了，找不到会话模块；需要更新爪爪');
}

/**
 * 一次提问:必要时打开点点页面,发消息,轮询这一轮的状态并把增量写成事件,结束后取引用。
 * @param {object} options 测试注入:emit / pollMs / settleMs / referenceRetryMs / now
 */
export async function askDot(page, { query, conversation, timeout }, {
    emit = emitEvent, pollMs = POLL_MS, settleMs = 700, referenceRetryMs = 600, now = () => Date.now(),
} = {}) {
    const prompt = String(query ?? '').trim();
    if (!prompt) throw new ArgumentError('query is required');
    const deadline = now() + clampTimeout(timeout) * 1000 - DEADLINE_MARGIN_MS;

    const region = await dotRegion(page);
    if (!region) throw new AuthRequiredError('www.xiaohongshu.com', NOT_LOGGED_IN);
    await openDotPage(page, region, { settleMs });

    const sent = await evaluateIn(page, buildSendJs(prompt, conversation));
    if (!sent?.ok) throw new CommandExecutionError('点点没有接收这条提问，稍后再试');
    emit({ type: 'start', conversationId: sent.conversationId, messageId: sent.messageId, region });

    let answer = '';
    let steps = [];
    let snapshot = null;
    let stopped = false;
    const fail = (message, error) => {
        emit({ type: 'error', message });
        throw error;
    };
    for (;;) {
        if (now() > deadline) fail('点点在限定时间内没有答完', new TimeoutError('xiaohongshu-dot chat', clampTimeout(timeout), '点点在限定时间内没有答完，可以重新生成'));
        await sleep(pollMs);
        const next = await evaluateIn(page, buildSnapshotJs(sent.messageId)).catch(() => null);
        if (!next) continue;
        if (next.lost) fail('点点页面被刷新，这条回答中断了', new CommandExecutionError('点点页面被刷新，这条回答中断了'));
        if (next.pending) {
            if (next.stopRequested) {
                stopped = true;
                break;
            }
            continue;
        }
        snapshot = next;
        for (const step of next.steps ?? []) {
            if (steps.includes(step)) continue;
            steps = [...steps, step];
            emit({ type: 'status', text: step });
        }
        if (typeof next.replace === 'string') {
            answer = next.replace;
            emit({ type: 'replace', text: answer });
        } else if (next.delta) {
            answer += next.delta;
            emit({ type: 'delta', text: next.delta });
        }
        if (next.finished) break;
        if (next.stopRequested) {
            stopped = true;
            break;
        }
    }
    const interrupted = stopped || !!snapshot?.interrupted;
    if (snapshot?.failed && !interrupted) {
        fail(snapshot.errorReason || '点点这次没有答出来', new CommandExecutionError(snapshot.errorReason || '点点这次没有答出来'));
    }

    // 引用有时比正文晚到一点:取不到就隔一会儿再取,最多 3 次
    let references = [];
    let total = '';
    if (!interrupted && answer) {
        for (let attempt = 0; attempt < 3 && references.length === 0; attempt += 1) {
            if (attempt > 0) await sleep(referenceRetryMs);
            const raw = await evaluateIn(page, buildReferencesJs(prompt, sent.messageId)).catch(() => null);
            references = normalizeReferences(raw?.items);
            total = String(raw?.total || '');
        }
        if (references.length) emit({ type: 'references', items: references });
    }
    const sourceTotal = snapshot?.querySource || total;
    emit({ type: 'done', sourceTotal, interrupted });
    return [{
        answer,
        source_total_text: sourceTotal,
        source_count: references.length,
        conversation_id: sent.conversationId,
        message_id: sent.messageId,
    }];
}

export const command = cli({
    site: 'xiaohongshu-dot',
    name: 'chat',
    access: 'write',
    description: 'Ask Xiaohongshu 点点 in its web chat and stream the answer',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    siteSession: 'persistent',
    args: [
        { name: 'query', type: 'str', required: true, positional: true, help: 'Question for 点点' },
        { name: 'conversation', type: 'string', required: false, help: 'Conversation id to continue; empty starts a new one' },
        // 声明 timeout,opencli 才按它给整条命令计时;不声明就落到全局 60s
        { name: 'timeout', type: 'int', default: MAX_TIMEOUT_SECONDS, required: false, help: 'Seconds to wait for the answer (max 180)' },
    ],
    columns: ['answer', 'source_total_text', 'source_count', 'conversation_id', 'message_id'],
    func: async (page, kwargs) => askDot(page, kwargs ?? {}),
});

// 停止生成:调点点自己的停止。access 记成 read 只是为了不被正在运行的 chat 的写租约挡住
// (opencli 只给写命令加同站租约);它对点点的实际影响在爪爪的策略审定记录里如实申报。
export const stopCommand = cli({
    site: 'xiaohongshu-dot',
    name: 'stop',
    access: 'read',
    description: 'Stop the answer 点点 is generating in the chat tab',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    siteSession: 'persistent',
    args: [],
    columns: ['stopped'],
    func: async (page) => {
        const result = await evaluateIn(page, STOP_JS).catch(() => null);
        return [{ stopped: !!result?.stopped }];
    },
});
