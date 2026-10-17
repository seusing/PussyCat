import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import { resolveXhsUserId } from './collection-helpers.js';
import { resolveXhsNoteLink } from './note-helpers.js';
import { findXhsLink, isXhsShortLink, resolveXhsProfileTarget } from './short-link.js';

const SAMPLE_FILE = resolve(process.cwd(), 'opencli-overrides/xiaohongshu/xhs-link-samples.json');
// 视频引擎仓库，与 scripts/build-vk-bundle.mjs 的 DEFAULT_PYTHON_SOURCE_DIR 一致。
const ENGINE_SAMPLE_FILE = 'C:/Users/Lauseusing/Developer/video-knowledge-m1-productization/tests/knowledge/fixtures/xhs_link_samples.json';
const readSamples = (file) => JSON.parse(readFileSync(file, 'utf8'));
const { samples } = readSamples(SAMPLE_FILE);

const redirectingFetch = (location) => vi.fn(async () => new Response(null, { status: location ? 302 : 200, headers: location ? { location } : {} }));
const isShort = (sample) => sample.kind.startsWith('short-');
const label = (sample) => `${sample.kind}: ${sample.input}`;
// 裸笔记 ID 和裸博主 ID 同为 24 位十六进制，无法区分，按博主 ID 处理。
const expectedUserId = (sample) => (sample.kind === 'note-id' ? sample.input : sample.userId ?? null);

afterEach(() => vi.unstubAllGlobals());

describe('xiaohongshu link samples', () => {
    it('only carry placeholder tokens and no sharer identity', () => {
        const text = JSON.stringify(samples);
        const tokens = [...text.matchAll(/xsec_token=([^&"\s]*)/g)].map(([, token]) => token);
        expect(tokens.length).toBeGreaterThan(0);
        expect(new Set(tokens)).toEqual(new Set(['SAMPLE']));
        expect(text).not.toMatch(/shareRedId|share_id|apptime/);
    });

    it('cover every documented kind', () => {
        expect(new Set(samples.map((sample) => sample.kind))).toEqual(new Set([
            'short-note', 'short-profile', 'short-invalid', 'note', 'note-unsigned', 'profile', 'user-id', 'note-id', 'other',
        ]));
    });

    it('findXhsLink picks the link out of every input', () => {
        for (const sample of samples) {
            expect(findXhsLink(sample.input), label(sample)).toBe(sample.link);
        }
    });

    it('isXhsShortLink is true exactly for the short kinds', () => {
        for (const sample of samples) {
            expect(isXhsShortLink(sample.link), label(sample)).toBe(isShort(sample));
        }
    });

    it('resolveXhsNoteLink returns a signed note link or explains in Chinese why not', async () => {
        for (const sample of samples) {
            const fetch = redirectingFetch(sample.location);
            const result = await resolveXhsNoteLink(sample.input, { fetch }).catch((error) => error);
            if (sample.kind === 'note' || sample.kind === 'short-note') {
                expect(result, label(sample)).toEqual(expect.stringContaining(sample.noteId));
                expect(result, label(sample)).toContain('xsec_token=');
            } else {
                expect(result, label(sample)).toBeInstanceOf(ArgumentError);
                if (sample.kind === 'note-unsigned') expect(result.message, label(sample)).toContain('缺少 xsec_token');
                else if (['profile', 'short-profile', 'short-invalid'].includes(sample.kind)) expect(result.message, label(sample)).toMatch(/不是.*笔记/);
                else expect(result.message, label(sample)).toBe('请填写小红书笔记链接');
            }
            expect(fetch, label(sample)).toHaveBeenCalledTimes(isShort(sample) ? 1 : 0);
            if (isShort(sample)) expect(fetch.mock.calls[0][0], label(sample)).toBe(sample.link);
        }
    });

    it('resolveXhsProfileTarget returns the user id of profile links and rejects everything else', async () => {
        for (const sample of samples) {
            const fetch = redirectingFetch(sample.location);
            const result = resolveXhsProfileTarget(sample.input, { fetch });
            const userId = expectedUserId(sample);
            if (userId) await expect(result, label(sample)).resolves.toMatchObject({ userId });
            else await expect(result, label(sample)).rejects.toBeInstanceOf(ArgumentError);
            expect(fetch, label(sample)).toHaveBeenCalledTimes(isShort(sample) ? 1 : 0);
        }
    });

    it('resolveXhsUserId takes the user id from the same inputs', async () => {
        for (const sample of samples) {
            const fetch = redirectingFetch(sample.location);
            vi.stubGlobal('fetch', fetch);
            const result = resolveXhsUserId(null, sample.input);
            const userId = expectedUserId(sample);
            if (userId) await expect(result, label(sample)).resolves.toBe(userId);
            else await expect(result, label(sample)).rejects.toBeInstanceOf(ArgumentError);
            expect(fetch, label(sample)).toHaveBeenCalledTimes(isShort(sample) ? 1 : 0);
        }
    });

    it.skipIf(!existsSync(ENGINE_SAMPLE_FILE))('match the video engine copy', () => {
        expect(readSamples(ENGINE_SAMPLE_FILE)).toEqual(readSamples(SAMPLE_FILE));
    });
});
