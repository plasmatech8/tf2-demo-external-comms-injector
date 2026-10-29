import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, transform } from 'esbuild';
import { compile, compileModule } from 'svelte/compiler';
import { render } from 'svelte/server';

let temp;
let createDemoSharing;
let Result;
let Page;
const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
const originalWindow = globalThis.window;
const demo = (name) => ({ id: crypto.randomUUID(), name, blob: new Blob(['HL2DEMO\0']) });

const sessionResponse = (share) =>
	Response.json({
		token: crypto.randomUUID(),
		id: share.id,
		deleteToken: share.deleteToken,
		partSize: 16 * 1024 * 1024
	});

before(async () => {
	temp = await mkdtemp(path.resolve('.wrangler/sharing-ui-tests-'));
	await build({
		entryPoints: {
			controller: 'src/lib/demo-sharing.svelte.ts',
			result: 'src/lib/components/GenerationResult.svelte',
			page: 'src/routes/+page.svelte'
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		packages: 'external',
		alias: { $lib: path.resolve('src/lib') },
		outdir: temp,
		outExtension: { '.js': '.mjs' },
		plugins: [
			{
				name: 'svelte-review-fixtures',
				setup(builder) {
					builder.onResolve({ filter: /^\$app\// }, (args) => ({
						path: args.path,
						namespace: 'app-fixture'
					}));
					builder.onLoad({ filter: /.*/, namespace: 'app-fixture' }, () => ({
						contents:
							'export const dev = true; export const resolve = (route, params = {}) => route.replace(/\\[([^\\]]+)\\]/g, (_, key) => params[key]);',
						loader: 'js'
					}));
					// Supply the controller to the real page without running browser onMount in SSR.
					builder.onResolve({ filter: /^\$lib\/demo-sharing\.svelte$/ }, () => ({
						path: 'controller',
						namespace: 'page-fixture'
					}));
					builder.onLoad({ filter: /.*/, namespace: 'page-fixture' }, () => ({
						contents: 'export const createDemoSharing = () => globalThis.qaSharing;',
						loader: 'js'
					}));
					// Media preparation is unrelated to rendering share status and needs a browser.
					builder.onResolve({ filter: /^\$lib\/(media|wasm)\/|^\$lib\/demo\/players$/ }, () => ({
						path: 'media',
						namespace: 'media-fixture'
					}));
					builder.onLoad({ filter: /.*/, namespace: 'media-fixture' }, () => ({
						contents:
							'export const listDemoPlayers = () => []; export const previewAroundGameStart = () => {}; export const previewMediaSource = () => {}; export const primeAudioContext = () => {}; export const inspectMedia = () => {}; export const prepareInjectWav = () => {}; export const injectCommsWasm = () => {}; export const preloadInjectorWasm = () => {};',
						loader: 'js'
					}));
					builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path: filename }) => {
						const source = await transform(await readFile(filename, 'utf8'), {
							loader: 'ts',
							target: 'esnext'
						});
						return {
							contents: compileModule(source.code, {
								filename: filename.replace(/\.ts$/, '.js'),
								generate: 'server'
							}).js.code,
							loader: 'js',
							resolveDir: path.dirname(filename)
						};
					});
					builder.onLoad({ filter: /\.svelte$/ }, async ({ path: filename }) => ({
						contents: compile(await readFile(filename, 'utf8'), {
							filename,
							generate: 'server',
							runes: true
						}).js.code,
						loader: 'js',
						resolveDir: path.dirname(filename)
					}));
				}
			}
		]
	});
	({ createDemoSharing } = await import(pathToFileURL(path.join(temp, 'controller.mjs'))));
	Result = (await import(pathToFileURL(path.join(temp, 'result.mjs')))).default;
	Page = (await import(pathToFileURL(path.join(temp, 'page.mjs')))).default;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.localStorage = originalStorage;
	globalThis.window = originalWindow;
	delete globalThis.qaSharing;
});

after(async () => {
	if (temp?.startsWith(path.resolve('.wrangler') + path.sep))
		await rm(temp, { recursive: true, force: true });
});

function resultHtml(sharing, generatedDemo) {
	return render(Result, {
		props: {
			sharing,
			demo: generatedDemo,
			generating: false,
			progress: 0,
			status: '',
			summary: 'Downloaded',
			enabled: true
		}
	}).body;
}

test('a failed upload only shows its error on the demo that failed', async () => {
	const sharing = createDemoSharing();
	const first = demo('first.dem');
	const second = demo('second.dem');
	globalThis.fetch = async () =>
		Response.json({ message: 'Upload for first demo failed.' }, { status: 400 });
	await sharing.createShare(first);
	assert.match(resultHtml(sharing, first), /Upload for first demo failed/);
	const next = resultHtml(sharing, second);
	assert.match(next, /second.dem/);
	assert.doesNotMatch(next, /Upload for first demo failed/);
	assert.equal(sharing.errorFor(null), '');
});

test('storage read failures are visible on the main page before any generation', () => {
	const sharing = createDemoSharing();
	globalThis.localStorage = {
		getItem() {
			throw new Error('Storage blocked');
		}
	};
	globalThis.window = { setInterval, addEventListener() {}, removeEventListener() {} };
	const dispose = sharing.mount();
	try {
		globalThis.qaSharing = sharing;
		const html = render(Page, { props: { data: { sharingEnabled: true } } }).body;
		assert.match(html, /Your saved links could not be read/);
		assert.doesNotMatch(html, /Create Share Link/);
	} finally {
		dispose();
	}
});

test('a shared result restores removed history without uploading or regenerating', async () => {
	const sharing = createDemoSharing();
	const generated = demo('restore.dem');
	const share = {
		id: crypto.randomUUID(),
		name: generated.name,
		size: generated.blob.size,
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 86400000).toISOString(),
		deleteToken: crypto.randomUUID()
	};
	let requests = 0;
	globalThis.localStorage = { getItem: () => null, setItem() {} };
	globalThis.fetch = async (url, options) => {
		requests++;
		if (url === '/api/shares') return sessionResponse(share);
		if (options.method === 'PUT') return Response.json({ partNumber: 1, etag: 'test' });
		return Response.json(share);
	};
	await sharing.createShare(generated);
	assert.match(resultHtml(sharing, generated), /Share link created/);
	sharing.removeLink(share.id);
	assert.match(resultHtml(sharing, generated), /Restore Share Link/);
	const beforeRestore = requests;
	await sharing.createShare(generated);
	assert.equal(requests, beforeRestore);
	assert.deepEqual(sharing.state.shares, [share]);
});

test('deletion uses an uploader-only header, removes history and allows a fresh share', async () => {
	const sharing = createDemoSharing();
	const generated = demo('delete.dem');
	const share = {
		id: crypto.randomUUID(),
		name: generated.name,
		size: generated.blob.size,
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 86400000).toISOString(),
		deleteToken: crypto.randomUUID()
	};
	let stored;
	globalThis.localStorage = {
		getItem: () => stored ?? null,
		setItem: (_, value) => {
			stored = value;
		}
	};
	let starts = 0;
	let deletes = 0;
	globalThis.fetch = async (url, options) => {
		if (options.method === 'DELETE') {
			deletes++;
			assert.equal(url, `/api/shared-demos/${share.id}`);
			assert.equal(options.headers.Authorization, `Bearer ${share.deleteToken}`);
			return new Response(null, { status: 204 });
		}
		if (url === '/api/shares') {
			starts++;
			return sessionResponse(share);
		}
		if (options.method === 'PUT') return Response.json({ partNumber: 1, etag: 'test' });
		return Response.json(share);
	};
	await sharing.createShare(generated);
	assert.equal(JSON.parse(stored)[0].deleteToken, share.deleteToken);
	await sharing.deleteShare(share);
	assert.equal(deletes, 1);
	assert.equal(sharing.state.shares.length, 0);
	assert.equal(sharing.isShared(generated), false);
	assert.match(resultHtml(sharing, generated), /Create Share Link/);
	assert.doesNotMatch(resultHtml(sharing, generated), /Restore Share Link/);
	await sharing.createShare(generated);
	assert.equal(starts, 2);
});

test('failed deletion keeps the link and its deletion key available for retry', async () => {
	const sharing = createDemoSharing();
	const share = {
		id: crypto.randomUUID(),
		name: 'retry.dem',
		size: 8,
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 86400000).toISOString(),
		deleteToken: crypto.randomUUID()
	};
	sharing.state.shares = [share];
	globalThis.fetch = async () => new Response(null, { status: 503 });
	await sharing.deleteShare(share);
	assert.deepEqual(sharing.state.shares, [share]);
	assert.match(sharing.state.deleteError, /Could not delete/);
	assert.equal(sharing.state.deletingId, '');
});

test('legacy history removal explains that it cannot revoke the old link', async () => {
	const sharing = createDemoSharing();
	const share = {
		id: crypto.randomUUID(),
		name: 'legacy.dem',
		size: 8,
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 86400000).toISOString()
	};
	sharing.state.shares = [share];
	globalThis.localStorage = { setItem() {} };
	globalThis.fetch = () => {
		throw new Error('Legacy links must not attempt unauthorized deletion');
	};
	await sharing.deleteShare(share);
	assert.equal(sharing.state.shares.length, 0);
	assert.match(sharing.state.storageWarning, /remains available until it expires/);
});

test('a large generated demo remains downloaded but its share button is disabled', () => {
	const html = resultHtml(createDemoSharing(), {
		...demo('large.dem'),
		blob: { size: 201 * 1024 * 1024 }
	});
	assert.match(html, /Downloaded/);
	assert.match(html, /200 MB/);
	assert.match(html, /<button[^>]*disabled/);
});

test('cancelling the native confirmation leaves the link and server file untouched', async () => {
	const sharing = createDemoSharing();
	const share = {
		id: crypto.randomUUID(),
		name: 'keep.dem',
		size: 8,
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 86400000).toISOString(),
		deleteToken: crypto.randomUUID()
	};
	sharing.state.shares = [share];
	let prompt = '';
	globalThis.window = {
		confirm(message) {
			prompt = message;
			return false;
		}
	};
	globalThis.fetch = () => {
		throw new Error('Cancellation must not send a delete request');
	};
	await sharing.requestDelete(share);
	assert.match(prompt, /keep.dem/);
	assert.match(prompt, /share link will stop working/);
	assert.deepEqual(sharing.state.shares, [share]);
	assert.equal(sharing.state.deletingId, '');
});

test('accepting the native confirmation sends deletion and clears local history', async () => {
	const sharing = createDemoSharing();
	const share = {
		id: crypto.randomUUID(),
		name: 'delete.dem',
		size: 8,
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 86400000).toISOString(),
		deleteToken: crypto.randomUUID()
	};
	sharing.state.shares = [share];
	globalThis.window = { confirm: () => true };
	globalThis.localStorage = { setItem() {} };
	let deletes = 0;
	globalThis.fetch = async (_, options) => {
		assert.equal(options.method, 'DELETE');
		deletes++;
		return new Response(null, { status: 204 });
	};
	await sharing.requestDelete(share);
	assert.equal(deletes, 1);
	assert.equal(sharing.state.shares.length, 0);
});

test('a new share does not drop an unexpired deletion key at the history cap', async () => {
	const sharing = createDemoSharing();
	const existing = Array.from({ length: 100 }, (_, index) => ({
		id: crypto.randomUUID(),
		name: `old-${index}.dem`,
		size: 8,
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
		deleteToken: crypto.randomUUID()
	}));
	const oldest = existing.at(-1);
	const created = {
		id: crypto.randomUUID(),
		name: 'new.dem',
		size: 8,
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
		deleteToken: crypto.randomUUID()
	};
	globalThis.localStorage = {
		getItem: () => JSON.stringify(existing),
		setItem() {}
	};
	globalThis.fetch = async (url, options) => {
		if (url === '/api/shares') return sessionResponse(created);
		if (options.method === 'PUT') return Response.json({ partNumber: 1, etag: 'test' });
		return Response.json(created);
	};
	await sharing.createShare(demo('new.dem'));
	assert.equal(sharing.state.shares.length, 101);
	assert.equal(sharing.state.shares[0].id, created.id);
	assert.ok(
		sharing.state.shares.some(
			(share) => share.id === oldest.id && share.deleteToken === oldest.deleteToken
		)
	);
});

test('failed cancellation shows a retry action and retains the cleanup capability', async () => {
	const sharing = createDemoSharing();
	const generated = demo('cancel-failure.dem');
	const token = crypto.randomUUID();
	const deleteToken = crypto.randomUUID();
	let attempts = 0;
	globalThis.fetch = async (url, options) => {
		if (url === '/api/shares')
			return Response.json({
				token,
				id: crypto.randomUUID(),
				deleteToken,
				partSize: 16 * 1024 * 1024
			});
		if (options.method === 'PUT') {
			sharing.cancelUpload();
			throw new DOMException('Cancelled', 'AbortError');
		}
		assert.equal(url, `/api/shares/${token}?cancel=1`);
		assert.equal(options.method, 'DELETE');
		assert.equal(options.headers.Authorization, `Bearer ${deleteToken}`);
		attempts++;
		return new Response('Temporary failure', { status: 503 });
	};
	await sharing.createShare(generated);
	assert.equal(attempts, 3);
	assert.equal(sharing.state.uploading, false);
	assert.match(sharing.state.cleanupError, /Could not finish cancelling/);
	globalThis.qaSharing = sharing;
	const html = render(Page, { props: { data: { sharingEnabled: true } } }).body;
	assert.match(html, /Retry cancellation/);
	assert.ok(!html.includes(token));
	assert.ok(!html.includes(deleteToken));
	await sharing.createShare(demo('next.dem'));
	assert.equal(attempts, 3, 'Another upload must not replace pending cleanup');
	globalThis.fetch = async (url, options) => {
		assert.equal(url, `/api/shares/${token}?cancel=1`);
		assert.equal(options.method, 'DELETE');
		assert.equal(options.headers.Authorization, `Bearer ${deleteToken}`);
		return new Response(null, { status: 204 });
	};
	await sharing.retryCleanup();
	assert.equal(sharing.state.cleanupError, '');
	assert.equal(sharing.state.cleanupRetrying, false);
});
