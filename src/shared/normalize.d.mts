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

export type ListOutput = { envelope: boolean; list: Record<string, unknown>[]; raw: string }

export function readListOutput(fetchPage: (extraArgs: string[]) => Promise<string>): Promise<ListOutput>
export function buildCommandsFromManifest(list: Record<string, unknown>[], manifest: Record<string, any>[]): CommandManifest[]
export function commandsFromList(output: Pick<ListOutput, 'envelope' | 'list'>, manifest: RawManifestCmd[]): CommandManifest[]
