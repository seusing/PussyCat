// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCommandsFromManifest, stripBom } from '../src/shared/normalize.mjs'
import { buildPolicyDecisions } from './policy.mjs'
import { reviewBaselineVersion, REVIEWED_RECORDS } from './policy-metadata.mjs'
import { reviewCarryHash, reviewShapeHash } from './policy-fingerprint.mjs'

const snapshot = JSON.parse(stripBom(readFileSync(resolve('public/catalog.snapshot.json'), 'utf8')))
const BASELINE = snapshot.opencliVersion
const NEW_VERSION = '2.0.2'
const find = (key) => snapshot.commands.find((c) => c.command === key)
const decisionsOf = (commands, version) => new Map(
  buildPolicyDecisions({ ...snapshot, opencliVersion: version, commands }).map((d) => [d.commandKey, d]),
)
// 换一个版本号,并让指定命令变形。
const upgraded = (key, mutate = (c) => c, version = NEW_VERSION) => decisionsOf(
  snapshot.commands.map((c) => (c.command === key ? mutate(c) : c)),
  version,
).get(key)

describe('2.0 目录条目 —— 参数按 1.8.8 口径规整后审定哈希不变', () => {
  // 2.0 cli-manifest.json 的条目形状:没有 aliases/valueRequired/positional,参数缺省字段省略。
  const manifest = [
    {
      site: 'bilibili', name: 'hot', description: 'Bilibili hot videos', access: 'read', domain: 'www.bilibili.com',
      strategy: 'cookie', browser: true,
      args: [{ name: 'limit', type: 'int', default: 20, required: false, help: 'Number of videos' }],
      columns: ['rank', 'title', 'author', 'play', 'danmaku', 'bvid', 'url'],
      type: 'js', modulePath: 'bilibili/hot.js', sourceFile: 'bilibili/hot.js', navigateBefore: 'https://www.bilibili.com',
    },
    {
      site: 'xiaohongshu', name: 'search', description: 'search', access: 'read', domain: 'www.xiaohongshu.com',
      strategy: 'cookie', browser: true,
      args: [
        { name: 'query', type: 'str', required: true, positional: true, help: 'Search keyword' },
        { name: 'limit', type: 'int', default: 20, required: false, help: 'Number of results' },
        { name: 'sort', type: 'string', default: 'general', required: false, choices: ['general', 'latest', 'likes', 'comments', 'collects'], help: 'Sort order: general, latest, likes, comments, collects' },
        { name: 'time', type: 'string', default: 'all', required: false, choices: ['all', 'day', 'week', 'half-year'], help: 'Publish time: all, day, week, half-year' },
        { name: 'type', type: 'string', default: 'all', required: false, choices: ['all', 'video', 'image'], help: 'Note type: all, video, image' },
      ],
      columns: ['rank', 'title', 'author', 'likes', 'type', 'published_at', 'url'],
      type: 'js', modulePath: 'xiaohongshu/search.js', sourceFile: 'xiaohongshu/search.js', navigateBefore: false,
    },
    {
      site: 'twitter', name: 'timeline', description: 'timeline', access: 'read', domain: 'x.com',
      strategy: 'cookie', browser: true,
      args: [
        { name: 'type', type: 'str', default: 'for-you', required: false, choices: ['for-you', 'following'], help: 'Which home-timeline feed to read. Default for-you (algorithmic). Use following for the chronological feed of accounts you follow.' },
        { name: 'limit', type: 'int', default: 20, required: false, help: 'Maximum number of tweets to return (default 20).' },
        { name: 'top-by-engagement', type: 'int', default: 0, required: false, help: 'When set to N>0, re-rank the timeline by weighted engagement (likes×1 + retweets×3 + replies×2 + bookmarks×5 + log10(views+1)×0.5) and return the top N. Default 0 keeps X\'s native ordering.' },
      ],
      // 2.0 里 twitter/timeline 的输出列比 1.8.8 少一列
      columns: ['id', 'author', 'text', 'likes', 'retweets', 'replies', 'views', 'created_at', 'url'],
      type: 'js', modulePath: 'twitter/timeline.js', sourceFile: 'twitter/timeline.js', navigateBefore: 'https://x.com',
    },
    { site: 'bilibili', name: 'broken', description: 'not loadable', access: 'read', args: [] },
  ]
  // list 里没有 bilibili broken(加载不了),也有 manifest 里没有的内置命令组。
  const list = [
    { command: 'browser open', description: 'Open a URL', access: 'read' },
    { command: 'bilibili hot', description: 'B站热门视频', access: 'read' },
    { command: 'xiaohongshu search', access: 'read' },
    { command: 'twitter timeline', description: 'Twitter timeline', access: 'read' },
  ]
  const built = buildCommandsFromManifest(list, manifest)
  const byKey = (key) => built.find((c) => c.command === key)

  it('只收 list 里出现过且在 manifest 里的命令,命令键是「站点/命令」', () => {
    expect(built.map((c) => c.command)).toEqual(['bilibili/hot', 'xiaohongshu/search', 'twitter/timeline'])
    expect(byKey('bilibili/hot')).toMatchObject({ site: 'bilibili', name: 'hot', aliases: [] })
  })

  it('description 以 list 为准,list 没给就用 manifest 的', () => {
    expect(byKey('bilibili/hot').description).toBe('B站热门视频')
    expect(byKey('xiaohongshu/search').description).toBe('search')
  })

  it('参数缺省字段补成 1.8.8 的口径', () => {
    expect(byKey('xiaohongshu/search').args[0]).toEqual({
      name: 'query', type: 'str', required: true, positional: true, valueRequired: false, choices: [], default: null, help: 'Search keyword',
    })
    expect(byKey('bilibili/hot').args[0]).toMatchObject({ valueRequired: false, positional: false, choices: [], default: 20 })
  })

  it('bilibili/hot、xiaohongshu/search 的 reviewShapeHash 与打包快照完全相同', () => {
    for (const key of ['bilibili/hot', 'xiaohongshu/search']) {
      expect(reviewShapeHash(byKey(key), BASELINE), key).toBe(reviewShapeHash(find(key), BASELINE))
    }
  })

  it('twitter/timeline 只有 columns 不同:完整哈希不同,沿用比对哈希相同', () => {
    const timeline = byKey('twitter/timeline')
    expect(reviewShapeHash(timeline, BASELINE)).not.toBe(reviewShapeHash(find('twitter/timeline'), BASELINE))
    expect(reviewCarryHash(timeline)).toBe(reviewCarryHash(find('twitter/timeline')))
  })

  it('用这样造出的条目换版本后,审定命令沿用(不是 review-stale)', () => {
    const commands = snapshot.commands.map((c) => byKey(c.command) ?? c)
    const decisions = decisionsOf(commands, NEW_VERSION)
    for (const key of ['bilibili/hot', 'xiaohongshu/search', 'twitter/timeline']) {
      expect(decisions.get(key).reasonCode, key).not.toBe('review-stale')
      expect(decisions.get(key).state, key).toBe('acknowledgement-required')
    }
  })
})

describe('reviewCarryHash', () => {
  const cmd = find('xiaohongshu/feed')

  it('不含 opencliVersion、columns 和展示字段', () => {
    const base = reviewCarryHash(cmd)
    expect(reviewCarryHash({ ...cmd, columns: ['x'] })).toBe(base)
    expect(reviewCarryHash({ ...cmd, description: 'CHANGED', example: 'CHANGED', aliases: ['a'] })).toBe(base)
  })

  it.each([
    ['access', 'write'], ['strategy', 'public'], ['browser', false], ['domain', 'evil.example'],
    ['modulePath', 'other.js'], ['navigateBefore', true], ['siteSession', 'persistent'], ['type', 'other'],
  ])('%s 变化改变哈希', (field, value) => {
    expect(reviewCarryHash({ ...cmd, [field]: value })).not.toBe(reviewCarryHash(cmd))
  })

  it('参数变化改变哈希', () => {
    expect(reviewCarryHash({ ...cmd, args: [...cmd.args, { name: 'extra', type: 'str' }] })).not.toBe(reviewCarryHash(cmd))
  })

  it('reviewShapeHash 在它之上多出 opencliVersion 与 columns', () => {
    expect(reviewShapeHash(cmd, '1.8.8')).not.toBe(reviewShapeHash(cmd, '2.0.2'))
    expect(reviewShapeHash({ ...cmd, columns: ['x'] }, '1.8.8')).not.toBe(reviewShapeHash(cmd, '1.8.8'))
  })
})

describe('审定基准', () => {
  it('基准版本取自打包快照', () => {
    expect(reviewBaselineVersion()).toBe(BASELINE)
  })

  it('每条审定记录都能拿到基准的沿用比对哈希', () => {
    expect(REVIEWED_RECORDS.size).toBe(18)
    for (const [key, record] of REVIEWED_RECORDS) {
      expect(record.reviewedCarry, key).toBe(reviewCarryHash(find(key)))
    }
  })
})

describe('审定沿用', () => {
  const REVIEWED = 'xiaohongshu/feed'

  it('同版本、命令不变:行为不变', () => {
    const baseline = decisionsOf(snapshot.commands, BASELINE)
    expect(baseline.get(REVIEWED).state).toBe('acknowledgement-required')
    expect(baseline.get('mercury/reimbursement-plan').state).toBe('ready')
    expect(baseline.get('trae-cn/setup').state).toBe('ready')
  })

  it('同版本下 columns 变了仍是 review-stale', () => {
    const d = upgraded(REVIEWED, (c) => ({ ...c, columns: ['x'] }), BASELINE)
    expect(d.reasonCode).toBe('review-stale')
  })

  it('同版本下参数变了是 review-stale', () => {
    const d = upgraded(REVIEWED, (c) => ({ ...c, args: [...c.args, { name: 'extra', type: 'str' }] }), BASELINE)
    expect(d.reasonCode).toBe('review-stale')
  })

  it('版本不同、参数一致 → 沿用审定', () => {
    const d = upgraded(REVIEWED)
    expect(d.state).toBe('acknowledgement-required')
    expect(d.decisionSource).toBe('tier-evaluation')
    expect(upgraded('mercury/reimbursement-plan').state).toBe('ready')
  })

  it('版本不同、只有 columns 变 → 沿用', () => {
    const d = upgraded(REVIEWED, (c) => ({ ...c, columns: ['only', 'new', 'columns'] }))
    expect(d.state).toBe('acknowledgement-required')
  })

  it('版本不同、参数变了 → review-stale', () => {
    expect(upgraded(REVIEWED, (c) => ({ ...c, args: [...c.args, { name: 'extra', type: 'str' }] })).reasonCode).toBe('review-stale')
    expect(upgraded(REVIEWED, (c) => ({ ...c, args: c.args.map((a) => ({ ...a, default: 99 })) })).reasonCode).toBe('review-stale')
  })

  it.each([
    ['access', 'write'],
    ['domain', 'evil.example'],
    ['modulePath', 'other.js'],
    ['strategy', 'public'],
    ['browser', false],
    ['navigateBefore', 'https://evil.example'],
    ['type', 'other'],
  ])('版本不同、%s 变了 → review-stale', (field, value) => {
    const d = upgraded(REVIEWED, (c) => ({ ...c, [field]: value }))
    expect(d.state).toBe('unknown')
    expect(d.reasonCode).toBe('review-stale')
  })

  it('decisionFingerprint 随版本变:需要确认的命令在新版里再确认一次', () => {
    const before = decisionsOf(snapshot.commands, BASELINE).get(REVIEWED).fingerprint
    const after = upgraded(REVIEWED).fingerprint
    expect(after).toEqual(expect.any(String))
    expect(after).not.toBe(before)
  })

  it('没有 reviewedCarry 的注入记录换版本后 fail-closed', () => {
    const host = 'trae-solo/state-get'
    const hostCommand = find(host)
    const records = new Map([[host, {
      reviewedAgainst: reviewShapeHash(hostCommand, BASELINE),
      metadata: { executionPath: 'direct-node', authorities: [], exposure: 'public', effects: [], credentialFlow: 'none', residues: [] },
    }]])
    const decide = (version) => new Map(buildPolicyDecisions({ ...snapshot, opencliVersion: version }, { records })
      .map((d) => [d.commandKey, d])).get(host)
    expect(decide(BASELINE).state).toBe('ready')
    expect(decide(NEW_VERSION).reasonCode).toBe('review-stale')
  })

  it('基准版本可注入:基准即当前版本时只认完整形状', () => {
    const decisions = new Map(buildPolicyDecisions(
      { ...snapshot, opencliVersion: NEW_VERSION, commands: snapshot.commands.map((c) => (c.command === REVIEWED ? { ...c, columns: ['x'] } : c)) },
      { baselineVersion: () => NEW_VERSION },
    ).map((d) => [d.commandKey, d]))
    expect(decisions.get(REVIEWED).reasonCode).toBe('review-stale')
  })
})
