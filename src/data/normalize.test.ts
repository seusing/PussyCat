import { stripBom, mergeManifestFields } from './normalize'
import type { CommandManifest } from './types'

test('stripBom 去除开头 BOM', () => {
  expect(stripBom('﻿[]')).toBe('[]')
  expect(stripBom('[]')).toBe('[]')
})

test('mergeManifestFields 按 site+name 补 navigateBefore/defaultWindowMode/type/modulePath', () => {
  const list: CommandManifest[] = [
    { command: '12306/login', site: '12306', name: 'login', description: '', access: 'write', browser: true, args: [] },
  ]
  const manifest = [
    { site: '12306', name: 'login', navigateBefore: false, defaultWindowMode: 'foreground', type: 'js', modulePath: '12306/auth.js' },
    { site: 'other', name: 'x', navigateBefore: true },
  ]
  const merged = mergeManifestFields(list, manifest)
  expect(merged[0].navigateBefore).toBe(false)
  expect(merged[0].defaultWindowMode).toBe('foreground')
  expect(merged[0].type).toBe('js')
  expect(merged[0].modulePath).toBe('12306/auth.js')
})

test('mergeManifestFields 对没有 manifest 对应项的命令保持原样', () => {
  const list: CommandManifest[] = [
    { command: 'baidubaike/search', site: 'baidubaike', name: 'search', description: '', access: 'read', browser: true, args: [] },
  ]
  const merged = mergeManifestFields(list, [])
  expect(merged[0].navigateBefore).toBeUndefined()
  expect(merged[0].site).toBe('baidubaike')
})
