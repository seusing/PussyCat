import { argHelp, commandDescription, hasZhCopy } from './zhCopy'

const PILOT = [
  'xiaohongshu/whoami', 'xiaohongshu/feed',
  'bilibili/whoami', 'bilibili/hot',
  'twitter/whoami', 'twitter/timeline',
  'youtube/whoami', 'youtube/subscriptions',
]

// 逐条一个用例:塞进单个循环的话,第一条失败即抛,后面的命令根本不会被执行——
// 「某条漏译」与「测试压根没跑到它」在输出上长得一模一样。
test.each(PILOT)('%s 有中文说明', (key) => {
  expect(hasZhCopy(key)).toBe(true)
  const zh = commandDescription(key, 'ENGLISH-FALLBACK')
  expect(zh).not.toBe('ENGLISH-FALLBACK')
  // 中文说明里不该混着未译的英文句子(允许 X / YouTube / B 站这类专名)
  expect(zh).toMatch(/[一-龥]/)
})

test('非试点命令回落 manifest 原文 —— 不做机翻,不留半截译文', () => {
  expect(commandDescription('bilibili/history', 'List recently watched videos'))
    .toBe('List recently watched videos')
  expect(hasZhCopy('bilibili/history')).toBe(false)
})

test('原文缺失时回落空串,不抛也不显示 undefined', () => {
  expect(commandDescription('nope/nope')).toBe('')
  expect(argHelp('nope/nope', 'limit')).toBe('')
})

test('参数说明**逐参数**回落 —— 译了 description 不等于每个参数都译了', () => {
  // twitter/timeline 三个参数都译了
  expect(argHelp('twitter/timeline', 'limit', 'EN')).not.toBe('EN')
  // 但一个表里没有的参数名必须原样回落,而不是拿命令级中文顶上
  expect(argHelp('twitter/timeline', 'not-a-real-arg', 'EN')).toBe('EN')
  // whoami 类命令没有参数,任何参数名都回落
  expect(argHelp('twitter/whoami', 'limit', 'EN')).toBe('EN')
})

test('文案是精简的:说明不复述实现细节(如加权公式)', () => {
  // 原文把 likes×1 + retweets×3 + … 整条公式写进了参数说明——那是实现说明不是使用说明。
  const help = argHelp('twitter/timeline', 'top-by-engagement', 'EN')
  expect(help).toContain('互动量')
  expect(help).not.toContain('×')
  expect(help.length).toBeLessThan(60)
})

test('saved 统一使用收藏夹文案，并说明列表模式不读取笔记', () => {
  expect(commandDescription('xiaohongshu/saved')).toContain('收藏夹')
  expect(commandDescription('xiaohongshu/saved')).not.toContain('专辑')
  expect(argHelp('xiaohongshu/saved', 'id')).toContain('当前登录账号')
  expect(argHelp('xiaohongshu/saved', 'collection')).toContain('收藏夹')
  expect(argHelp('xiaohongshu/saved', 'list-collections')).toBe('只列出收藏夹，不读取笔记')
})

test('collections 保留旧记录的中文说明', () => {
  expect(commandDescription('xiaohongshu/collections')).toContain('收藏专辑')
  expect(argHelp('xiaohongshu/collections', 'id')).toContain('当前登录账号')
})
