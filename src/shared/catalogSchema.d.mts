import type { CommandManifest } from '../data/types'

export class CatalogSchemaError extends Error {}
export function assertCatalogCommands(commands: unknown): asserts commands is CommandManifest[]
