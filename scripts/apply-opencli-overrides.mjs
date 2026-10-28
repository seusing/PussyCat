import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyOpencliOverrides } from '../server/opencli-overrides.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetArg = process.argv.find((arg) => arg.startsWith('--target='))
const packageRoot = resolve(root, targetArg ? targetArg.slice('--target='.length) : 'node_modules/@jackwener/opencli')

applyOpencliOverrides({ packageRoot, sourceDir: join(root, 'opencli-overrides/xiaohongshu') })
console.log(`[opencli-overrides] applied to ${packageRoot}`)
