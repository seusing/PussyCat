import { HostRequestError } from '../../host/errors'
import { ENGINE_NOT_READY_TEXT, vkErrorNote, vkErrorText, vkStageFailureNote } from './vkErrors'

describe('视频解析错误文案', () => {
  test('引擎未就绪:统一成人话,宿主原文与 reasonCode 只进 title', () => {
    for (const code of ['not-installed', 'not-configured']) {
      const note = vkErrorNote(new HostRequestError('video-knowledge runtime 未安装或未配置', undefined, 503, code), '兜底')
      expect(note.text).toBe(ENGINE_NOT_READY_TEXT)
      expect(note.text).not.toMatch(/video-knowledge|runtime|sidecar|not-/)
      expect(note.title).toBe(`video-knowledge runtime 未安装或未配置(${code})`)
    }
  })

  test('其它宿主错误:正文只有 summary,reasonCode 放进 title', () => {
    const note = vkErrorNote(new HostRequestError('解析引擎启动超时', undefined, 503, 'spawn-timeout'), '兜底')
    expect(note).toEqual({ text: '解析引擎启动超时', title: '解析引擎启动超时(spawn-timeout)' })
  })

  test('没有 reasonCode 的宿主错误没有 title', () => {
    expect(vkErrorNote(new HostRequestError('任务不存在', undefined, 404), '兜底')).toEqual({ text: '任务不存在', title: undefined })
  })

  test('503 但 reasonCode 不是引擎未就绪时不套用那句话', () => {
    expect(vkErrorText(new HostRequestError('解析环境没装成功', undefined, 503, 'install-failed'), '兜底')).toBe('解析环境没装成功')
    expect(vkErrorText(new HostRequestError('不存在', undefined, 404, 'not-installed'), '兜底')).toBe('不存在')
  })

  test('普通 Error 取 message,什么都没有取兜底', () => {
    expect(vkErrorText(new Error('网络中断'), '兜底')).toBe('网络中断')
    expect(vkErrorText(new Error(''), '兜底')).toBe('兜底')
    expect(vkErrorText('boom', '兜底')).toBe('兜底')
  })

  test.each([
    ['storyline_reduce', '，这条故事线只保留了各集摘要，可以点「串联分析」重新生成'],
    ['comparison_reduce', '，这组观点对比没有生成'],
    ['series_digest', '，这个视频改用简化摘要参与串联'],
    ['storyline_link', '，这一组视频的关系没有判定出来'],
    ['storyline_relate', ''],
  ])('阶段 %s 两次输出均不可用:第一句固定,按阶段补后果,原文进 title', (stage, consequence) => {
    const raw = stage + ' 两次输出均不可用：缺少 episodes'
    expect(vkStageFailureNote(raw)).toEqual({ text: '模型两次都没有按格式返回' + consequence, title: raw })
  })

  test('认不出的阶段失败原文返回 null', () => {
    expect(vkStageFailureNote('channel-a:default HTTP 429')).toBeNull()
    expect(vkStageFailureNote('前缀 storyline_reduce 两次输出均不可用')).toBeNull()
    expect(vkStageFailureNote('')).toBeNull()
  })
})
