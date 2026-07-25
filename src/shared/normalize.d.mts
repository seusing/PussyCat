import type { CommandManifest } from '../data/types'

export type RawManifestCmd = {
  site: string
  name: string
  navigateBefore?: boolean | string
  defaultWindowMode?: string
  type?: string
  modulePath?: string
}

export function stripBom(s: string): string
export function mergeManifestFields(list: CommandManifest[], manifest: RawManifestCmd[]): CommandManifest[]
