import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { getRequest, setResponse } from '@sveltejs/kit/node';
import { isHttpError } from '@sveltejs/kit';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

let runtime;
let bucket;
let server;
let downloads;
let contracts;
let client;
let createApi;
let uploadApi;
let landing;
let deleteApi;
let temp;

before(async () => {
	await mkdir('.wrangler', { recursive: true });
	temp = await mkdtemp(path.resolve('.wrangler/share-tests-'));
	await build({
		entryPoints: {
			server: 'src/lib/server/shares.ts',
			downloads: 'src/routes/share/[id]/download/+server.ts',
			landing: 'src/routes/share/[id]/+page.server.ts',
			contracts: 'src/lib/shares.ts',
			client: 'src/lib/share-upload.ts',
			createApi: 'src/routes/api/shares/+server.ts',
			uploadApi: 'src/routes/api/shares/[token]/+server.ts',
			deleteApi: 'src/routes/api/shared-demos/[id]/+server.ts'
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		packages: 'external',
		alias: { $lib: path.resolve('src/lib') },
		outdir: temp,
		outExtension: { '.js': '.mjs' }
	});
	[server, downloads, contracts, client, createApi, uploadApi, landing, deleteApi] =
		await Promise.all(
			[
				'server',
				'downloads',
				'contracts',
				'client',
				'createApi',
				'uploadApi',
				'landing',
				'deleteApi'
			].map((name) => import(pathToFileURL(path.join(temp, `${name}.mjs`)).href))
		);
	runtime = new Miniflare({
		modules: true,
		script: 'export default { fetch() { return new Response("test"); } }',
		compatibilityDate: '2026-07-26',
		r2Buckets: ['SHARED_DEMOS']
	});
	bucket = await runtime.getR2Bucket('SHARED_DEMOS');
});

after(async () => {
	await runtime?.dispose();
	if (temp && temp.startsWith(path.resolve('.wrangler') + path.sep))
		await rm(temp, { recursive: true, force: true });
});

function jsonRequest(value) {
	return new Request('https://example.com/api/shares', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(value)
	});
}

function downloadEvent(id, method = 'GET', storage = bucket) {
	return {
		params: { id },
		request: new Request(`https://example.com/share/${id}/download`, { method }),
		platform: { env: { SHARED_DEMOS: storage } }
	};
}

async function uploadBytes(bytes, name = 'match_with_comms.dem') {
	const { token, deleteToken } = await server.startShare(bucket, { name, size: bytes.length });
	const session = await server.getUpload(bucket, token);
	const parts = [];
	for (let offset = 0; offset < bytes.length; offset += contracts.SHARE_PART_SIZE) {
		const body = bytes.slice(offset, offset + contracts.SHARE_PART_SIZE);
		parts.push(
			await server.uploadSharePart(
				bucket,
				session,
				parts.length + 1,
				new Request('https://example.com/upload', {
					method: 'PUT',
					headers: { 'Content-Length': String(body.length) },
					body
				})
			)
		);
	}
	const publicShare = await server.completeShare(bucket, session, { parts });
	return { share: { ...publicShare, deleteToken }, token, session, parts };
}

test('multipart R2 roundtrip preserves bytes, filename, expiry, and retry identity', async () => {
	const bytes = new Uint8Array(contracts.SHARE_PART_SIZE + 128);
	bytes.set(new TextEncoder().encode('HL2DEMO\0'));
	bytes[bytes.length - 1] = 42;
	const { share, token, session, parts } = await uploadBytes(bytes, 'match_音声.dem');
	assert.notEqual(token, share.id);
	assert.equal(
		Date.parse(share.expiresAt) - Date.parse(share.createdAt),
		contracts.SHARE_LIFETIME_MS
	);
	const { deleteToken, ...publicShare } = share;
	assert.ok(deleteToken);
	assert.deepEqual(await server.completeShare(bucket, session, { parts }), publicShare);
	const response = await downloads.GET(downloadEvent(share.id));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
	assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
	assert.match(response.headers.get('Content-Disposition'), /match_%E9%9F%B3%E5%A3%B0\.dem/);
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
	const head = await downloads.HEAD(downloadEvent(share.id, 'HEAD'));
	assert.equal(head.status, 200);
	assert.equal(head.headers.get('Content-Length'), String(bytes.length));
	assert.equal(await head.text(), '');
	// Cleanup after a lost response cannot destroy a completed download.
	await server.abortShare(bucket, session, token);
	assert.ok(await bucket.head(server.demoKey(share.id)));
	await assert.rejects(server.getUpload(bucket, token), { status: 404 });
});

test('explicit cancel deletes a demo that finished before the response was aborted', async () => {
	const bytes = new TextEncoder().encode('HL2DEMO\0cancel');
	const { share, token } = await uploadBytes(bytes, 'cancel.dem');
	const response = await uploadApi.DELETE({
		request: new Request(`https://example.com/api/shares/${token}?cancel=1`, {
			method: 'DELETE',
			headers: { Origin: 'https://example.com', Authorization: `Bearer ${share.deleteToken}` }
		}),
		url: new URL(`https://example.com/api/shares/${token}?cancel=1`),
		platform: { env: { SHARED_DEMOS: bucket } },
		params: { token }
	});
	assert.equal(response.status, 204);
	assert.equal(await bucket.head(server.demoKey(share.id)), null);
	assert.equal((await server.getUpload(bucket, token)).cancelled, true);
});

test('failed cancellation retains its capability and retries deletion without resuming the upload', async () => {
	const { share, token, session, parts } = await uploadBytes(
		new TextEncoder().encode('HL2DEMO\0cleanup'),
		'cleanup.dem'
	);
	let failDelete = true;
	const unreliable = new Proxy(bucket, {
		get(target, property) {
			if (property === 'delete')
				return async (key) => {
					if (failDelete && key === server.demoKey(share.id)) {
						failDelete = false;
						throw new Error('Transient deletion failure');
					}
					return target.delete(key);
				};
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	const event = () => ({
		request: new Request(`https://example.com/api/shares/${token}?cancel=1`, {
			method: 'DELETE',
			headers: { Origin: 'https://example.com', Authorization: `Bearer ${share.deleteToken}` }
		}),
		url: new URL(`https://example.com/api/shares/${token}?cancel=1`),
		platform: { env: { SHARED_DEMOS: unreliable } },
		params: { token }
	});
	await assert.rejects(uploadApi.DELETE(event()), /Transient deletion failure/);
	assert.ok(await bucket.head(server.demoKey(share.id)));
	const cancelled = await server.getUpload(bucket, token);
	assert.equal(cancelled.cancelled, true);
	assert.equal(cancelled.deleteToken, undefined);
	assert.equal(cancelled.deleteProof, session.deleteProof);
	await assert.rejects(server.completeShare(bucket, cancelled, { parts }, token), { status: 409 });
	await assert.rejects(
		server.uploadSharePart(bucket, cancelled, 1, new Request('https://example.com')),
		{ status: 409 }
	);
	assert.equal((await uploadApi.DELETE(event())).status, 204);
	assert.equal(await bucket.head(server.demoKey(share.id)), null);
	// A lost cleanup response can be retried safely, including with a stale session.
	assert.equal((await uploadApi.DELETE(event())).status, 204);
	await assert.rejects(server.completeShare(bucket, session, { parts }, token), { status: 409 });
	assert.equal(await bucket.head(server.demoKey(share.id)), null);
});

test('completion rolls back when cancellation happens after its initial session check', async () => {
	const { share, token, session, parts } = await uploadBytes(
		new TextEncoder().encode('HL2DEMO\0race'),
		'race.dem'
	);
	let reads = 0;
	const racing = new Proxy(bucket, {
		get(target, property) {
			if (property === 'get')
				return async (key) => {
					if (key === `uploads/${token}.json` && ++reads === 2)
						await server.abortShare(bucket, session, token, true);
					return target.get(key);
				};
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	await assert.rejects(server.completeShare(racing, session, { parts }, token), { status: 409 });
	assert.equal(reads, 2);
	assert.equal(await bucket.head(server.demoKey(share.id)), null);
});

test('completion refuses an upload whose session has already been removed', async () => {
	const bytes = new TextEncoder().encode('HL2DEMO\0race');
	const { token } = await server.startShare(bucket, { name: 'race.dem', size: bytes.length });
	const session = await server.getUpload(bucket, token);
	const part = await server.uploadSharePart(
		bucket,
		session,
		1,
		new Request('https://example.com/upload', { method: 'PUT', body: bytes })
	);
	const listed = await bucket.list({ prefix: 'uploads/' });
	const sessionKey = listed.objects.find((object) => object.key.includes(token))?.key;
	assert.ok(sessionKey);
	await bucket.delete(sessionKey);
	await assert.rejects(server.completeShare(bucket, session, { parts: [part] }, token), {
		status: 409
	});
	assert.equal(await bucket.head(server.demoKey(session.id)), null);
});

test('download expiry is enforced at the boundary for GET and HEAD', async () => {
	const id = crypto.randomUUID();
	const uploaded = new Date(Date.now() - contracts.SHARE_LIFETIME_MS);
	const expiredBucket = {
		get: async () => ({ key: server.demoKey(id), size: 8, uploaded, body: new ReadableStream() }),
		head: async () => ({ key: server.demoKey(id), size: 8, uploaded })
	};
	for (const method of ['GET', 'HEAD']) {
		const result = await downloads[method](downloadEvent(id, method, expiredBucket));
		assert.equal(result.status, 410);
		assert.equal(result.headers.get('Cache-Control'), 'no-store');
	}
	assert.equal((await downloads.GET(downloadEvent('invalid'))).status, 404);
	assert.equal((await downloads.GET(downloadEvent(crypto.randomUUID()))).status, 404);
});

test('landing page reads metadata without downloading the object and disables caching', async () => {
	const { share } = await uploadBytes(new TextEncoder().encode('HL2DEMO\0page'));
	const headers = {};
	let heads = 0;
	const metadataBucket = {
		head: async (key) => {
			heads++;
			return bucket.head(key);
		},
		get: () => {
			throw new Error('Visiting a shared page must not download the demo');
		}
	};
	const data = await landing.load({
		params: { id: share.id },
		platform: { env: { SHARED_DEMOS: metadataBucket } },
		setHeaders: (value) => Object.assign(headers, value)
	});
	const { deleteToken, ...publicShare } = share;
	assert.ok(deleteToken);
	assert.deepEqual(data.share, publicShare);
	assert.ok(!JSON.stringify(data).includes(deleteToken));
	assert.ok(!JSON.stringify(data).includes('deleteProof'));
	assert.equal(heads, 1);
	assert.equal(headers['Cache-Control'], 'private, no-store');
	assert.equal(headers['X-Robots-Tag'], 'noindex, nofollow');
	assert.equal(headers['Referrer-Policy'], 'no-referrer');
});

test('landing page returns appropriate statuses for expired, absent, invalid and unavailable demos', async () => {
	const id = crypto.randomUUID();
	const expiredBucket = {
		head: async () => ({
			key: server.demoKey(id),
			size: 8,
			uploaded: new Date(Date.now() - contracts.SHARE_LIFETIME_MS)
		})
	};
	await assert.rejects(
		landing.load({
			params: { id },
			platform: { env: { SHARED_DEMOS: expiredBucket } },
			setHeaders: () => {}
		}),
		{ status: 410 }
	);
	await assert.rejects(server.getSharedDemoInfo(bucket, crypto.randomUUID()), { status: 404 });
	await assert.rejects(server.getSharedDemoInfo(bucket, 'invalid'), { status: 404 });
	await assert.rejects(landing.load({ params: { id }, setHeaders: () => {} }), { status: 503 });
});

test('expiry copy communicates remaining time and the exact expiration boundary', () => {
	const now = Date.parse('2026-10-28T00:00:00Z');
	const label = (duration) =>
		contracts.shareExpiryLabel(new Date(now + duration).toISOString(), now);
	assert.equal(label(7 * 86_400_000), 'Expires in 7 days');
	assert.equal(label(11.5 * 86_400_000), 'Expires in 12 days');
	assert.equal(label(86_400_000), 'Expires in 1 day');
	assert.equal(label(2.5 * 3_600_000), 'Expires in 3 hours');
	assert.equal(label(60_000), 'Expires in 1 minute');
	assert.equal(label(30_000), 'Expires in less than a minute');
	assert.equal(label(0), 'Expired');
	assert.equal(label(-1), 'Expired');
});

test('upload validation rejects cross-origin, excessive sizes, malformed JSON, and missing configuration', async () => {
	assert.throws(() => server.getShareBucket(undefined), { status: 503 });
	assert.throws(
		() =>
			server.requireSameOrigin(
				new Request('https://example.com', { headers: { Origin: 'https://other.com' } }),
				new URL('https://example.com')
			),
		{ status: 403 }
	);
	await assert.rejects(
		server.startShare(bucket, { name: 'x.dem', size: contracts.MAX_SHARE_SIZE + 1 }),
		{ status: 413 }
	);
	await assert.rejects(server.startShare(bucket, { name: 'x.html', size: 10 }), { status: 400 });
	await assert.rejects(server.readShareJson(jsonRequest('x'.repeat(33000))), { status: 413 });
	await assert.rejects(
		server.readShareJson(
			new Request('https://example.com', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{'
			})
		),
		{ status: 400 }
	);
});

test('invalid signatures, missing parts, part sizes, and upload tokens are rejected', async () => {
	const { token } = await server.startShare(bucket, { name: 'x.dem', size: 8 });
	const session = await server.getUpload(bucket, token);
	await assert.rejects(server.getUpload(bucket, session.id), { status: 404 });
	await assert.rejects(server.uploadSharePart(bucket, session, 2, jsonRequest({})), {
		status: 400
	});
	await assert.rejects(
		server.uploadSharePart(
			bucket,
			session,
			1,
			new Request('https://example.com', {
				method: 'PUT',
				body: 'invalid!',
				headers: { 'Content-Length': '8' }
			})
		),
		{ status: 400 }
	);
	await assert.rejects(
		server.uploadSharePart(
			bucket,
			session,
			1,
			new Request('https://example.com', {
				method: 'PUT',
				body: 'short',
				headers: { 'Content-Length': '5' }
			})
		),
		{ status: 400 }
	);
	await assert.rejects(server.completeShare(bucket, session, { parts: [] }), { status: 400 });
	await assert.rejects(
		server.completeShare(bucket, session, { parts: [{ partNumber: 1, etag: '' }] }),
		{ status: 400 }
	);
	await server.abortShare(bucket, session, token);
});

test('saved history tolerates invalid entries, deduplicates, and preserves expired links', () => {
	const share = {
		id: crypto.randomUUID(),
		name: 'x.dem',
		size: 8,
		createdAt: '2025-01-01T00:00:00Z',
		expiresAt: '2025-01-08T00:00:00.000Z'
	};
	assert.deepEqual(contracts.readSavedShares(null), []);
	assert.deepEqual(contracts.readSavedShares('{}'), []);
	assert.deepEqual(
		contracts.readSavedShares(
			JSON.stringify([
				null,
				share,
				share,
				{ ...share, id: 'javascript:alert(1)' },
				{ ...share, id: crypto.randomUUID(), expiresAt: 'bad' }
			])
		),
		[share]
	);
	assert.equal(contracts.shareIsExpired(share, Date.parse(share.expiresAt)), true);
	assert.equal(contracts.shareIsExpired(share, Date.parse(share.expiresAt) - 1), false);
});

test('200 MB upload limit and seven-day expiry agree with bucket cleanup', async () => {
	assert.equal(contracts.MAX_SHARE_SIZE, 200 * 1024 * 1024);
	assert.equal(contracts.SHARE_LIFETIME_MS, 7 * 86400000);
	const { token } = await server.startShare(bucket, {
		name: 'limit.dem',
		size: contracts.MAX_SHARE_SIZE
	});
	await server.abortShare(bucket, await server.getUpload(bucket, token), token);
	await assert.rejects(
		server.startShare(bucket, { name: 'too-big.dem', size: contracts.MAX_SHARE_SIZE + 1 }),
		{ status: 413 }
	);
	await assert.rejects(
		client.uploadDemo(
			{ name: 'too-big.dem', blob: { size: contracts.MAX_SHARE_SIZE + 1 } },
			'/api/shares',
			new AbortController().signal,
			() => {}
		),
		/200 MB/
	);
	const lifecycle = JSON.parse(await readFile('r2-lifecycle.json', 'utf8'));
	assert.equal(
		lifecycle.rules.find(
			(rule) => rule.conditions.prefix === 'demos/' && rule.deleteObjectsTransition
		).deleteObjectsTransition.condition.maxAge * 1000,
		contracts.SHARE_LIFETIME_MS
	);
});

test('history preserves deletion keys and shortens legacy expiry without losing larger links', () => {
	const old = {
		id: crypto.randomUUID(),
		name: 'legacy.dem',
		size: 300 * 1024 * 1024,
		createdAt: '2026-10-01T00:00:00.000Z',
		expiresAt: '2026-10-15T00:00:00.000Z'
	};
	const deleteToken = crypto.randomUUID();
	const [restored] = contracts.readSavedShares(JSON.stringify([{ ...old, deleteToken }]));
	assert.equal(restored.expiresAt, '2026-10-08T00:00:00.000Z');
	assert.equal(restored.deleteToken, deleteToken);
	assert.equal(restored.size, old.size);
	const [invalid] = contracts.readSavedShares(JSON.stringify([{ ...old, deleteToken: 'invalid' }]));
	assert.equal(invalid.deleteToken, undefined);
});

test('history keeps unexpired deletion keys past the saved-link cap', () => {
	const now = Date.now();
	const share = (name, expiresAt, deleteToken) => ({
		id: crypto.randomUUID(),
		name,
		size: 8,
		createdAt: new Date(now - 86_400_000).toISOString(),
		expiresAt,
		...(deleteToken ? { deleteToken } : {})
	});
	const active = Array.from({ length: 101 }, (_, index) =>
		share(`active-${index}.dem`, new Date(now + 86_400_000).toISOString(), crypto.randomUUID())
	);
	const oldest = active.at(-1);
	const expired = share('expired.dem', new Date(now - 1000).toISOString(), crypto.randomUUID());
	const tokenless = share('legacy.dem', new Date(now + 86_400_000).toISOString());
	const kept = contracts.readSavedShares(JSON.stringify([tokenless, ...active, expired]));
	assert.equal(kept.length, 101);
	assert.ok(kept.some((item) => item.id === oldest.id && item.deleteToken === oldest.deleteToken));
	assert.equal(
		kept.some((item) => item.id === tokenless.id || item.id === expired.id),
		false
	);
	const legacy = Array.from({ length: contracts.MAX_SAVED_SHARES + 1 }, (_, index) =>
		share(`legacy-${index}.dem`, new Date(now + 86_400_000).toISOString())
	);
	const capped = contracts.readSavedShares(JSON.stringify(legacy));
	assert.equal(capped.length, contracts.MAX_SAVED_SHARES);
	assert.equal(capped.at(-1).id, legacy.at(-2).id);
	assert.equal(
		capped.some((item) => item.id === legacy.at(-1).id),
		false
	);
});

test('only the uploader can delete a demo; deletion immediately revokes GET, HEAD and metadata', async () => {
	const first = await uploadBytes(new TextEncoder().encode('HL2DEMO\0delete'));
	const other = await uploadBytes(new TextEncoder().encode('HL2DEMO\0other'));
	const { id, deleteToken } = first.share;
	assert.notEqual(deleteToken, id);
	assert.notEqual(deleteToken, first.token);
	for (const wrong of ['', id, first.token, other.share.deleteToken, crypto.randomUUID()]) {
		await assert.rejects(server.deleteSharedDemo(bucket, id, wrong), { status: 403 });
	}
	assert.ok(await bucket.head(server.demoKey(id)));
	const event = (origin, secret) => ({
		url: new URL(`https://example.com/api/shared-demos/${id}`),
		params: { id },
		platform: { env: { SHARED_DEMOS: bucket } },
		request: new Request(`https://example.com/api/shared-demos/${id}`, {
			method: 'DELETE',
			headers: { Origin: origin, Authorization: `Bearer ${secret}` }
		})
	});
	await assert.rejects(deleteApi.DELETE(event('https://other.com', deleteToken)), { status: 403 });
	const response = await deleteApi.DELETE(event('https://example.com', deleteToken));
	assert.equal(response.status, 204);
	assert.equal(response.headers.get('Cache-Control'), 'no-store');
	assert.equal((await downloads.GET(downloadEvent(id))).status, 404);
	assert.equal((await downloads.HEAD(downloadEvent(id, 'HEAD'))).status, 404);
	await assert.rejects(server.getSharedDemoInfo(bucket, id), { status: 404 });
	assert.equal((await deleteApi.DELETE(event('https://example.com', deleteToken))).status, 204);
	assert.ok(await bucket.head(server.demoKey(other.share.id)));
	await assert.rejects(server.completeShare(bucket, first.session, { parts: first.parts }));
	assert.equal((await downloads.GET(downloadEvent(id))).status, 404);
});

test('server-accepted Unicode filenames survive history reload and download headers', async () => {
	for (const name of ['🎮'.repeat(100) + '_with_comms.dem', '🎮'.repeat(250) + '.dem']) {
		const { share } = await uploadBytes(new TextEncoder().encode('HL2DEMO\0'), name);
		assert.ok(Array.from(share.name).length <= contracts.MAX_SHARE_NAME_LENGTH);
		assert.deepEqual(contracts.readSavedShares(JSON.stringify([share])), [share]);
		const response = await downloads.GET(downloadEvent(share.id));
		assert.equal(response.status, 200);
		assert.ok(response.headers.get('Content-Disposition').includes(encodeURIComponent(share.name)));
		await response.body.cancel();
	}
});

test('upload streams without Content-Length are bounded and accepted when complete', async () => {
	const { token } = await server.startShare(bucket, { name: 'stream.dem', size: 8 });
	const session = await server.getUpload(bucket, token);
	const request = new Request('https://example.com', {
		method: 'PUT',
		body: 'HL2DEMO\0',
		headers: { 'Content-Type': 'application/octet-stream' }
	});
	assert.equal(request.headers.get('Content-Length'), null);
	const part = await server.uploadSharePart(bucket, session, 1, request);
	assert.equal(part.partNumber, 1);
	await assert.rejects(
		server.uploadSharePart(
			bucket,
			session,
			1,
			new Request('https://example.com', {
				method: 'PUT',
				body: 'HL2DEMO\0extra',
				headers: { 'Content-Type': 'application/octet-stream' }
			})
		),
		{ status: 413 }
	);
	await server.abortShare(bucket, session, token);
});

test('actual client uploads and downloads through the SvelteKit Node adapter and local R2', async () => {
	const nativeFetch = globalThis.fetch;
	const http = createServer(async (incoming, outgoing) => {
		try {
			const base = `http://127.0.0.1:${http.address().port}`;
			const request = await getRequest({ request: incoming, base });
			const url = new URL(request.url);
			const event = { request, url, platform: { env: { SHARED_DEMOS: bucket } }, params: {} };
			let response;
			if (url.pathname === '/api/shares') response = await createApi.POST(event);
			else if (url.pathname.startsWith('/api/shares/')) {
				event.params.token = url.pathname.split('/').at(-1);
				response = await uploadApi[request.method](event);
			} else {
				event.params.id = url.pathname.split('/')[2];
				response = await downloads.GET(event);
			}
			await setResponse(outgoing, response);
		} catch (cause) {
			outgoing.writeHead(isHttpError(cause) ? cause.status : 500, {
				'Content-Type': 'application/json'
			});
			outgoing.end(
				JSON.stringify({ message: isHttpError(cause) ? cause.body.message : String(cause) })
			);
		}
	});
	await new Promise((resolve, reject) => {
		http.once('error', reject);
		http.listen(0, '127.0.0.1', resolve);
	});
	const base = `http://127.0.0.1:${http.address().port}`;
	globalThis.fetch = (url, options) => {
		const headers = new Headers(options?.headers);
		headers.set('Origin', base);
		return nativeFetch(new URL(url, base), { ...options, headers });
	};
	try {
		const bytes = new Uint8Array(contracts.SHARE_PART_SIZE + 20);
		bytes.set(new TextEncoder().encode('HL2DEMO\0'));
		bytes[bytes.length - 1] = 73;
		const share = await client.uploadDemo(
			{ id: crypto.randomUUID(), name: 'node-adapter.dem', blob: new Blob([bytes]) },
			'/api/shares',
			new AbortController().signal,
			() => {}
		);
		const response = await nativeFetch(`${base}/share/${share.id}/download`);
		assert.equal(response.status, 200);
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
	} finally {
		globalThis.fetch = nativeFetch;
		await new Promise((resolve) => {
			http.close(resolve);
			http.closeAllConnections();
		});
	}
});

test('client retries transient parts and lost completion responses using the same output', async () => {
	const nativeFetch = globalThis.fetch;
	const token = crypto.randomUUID();
	const blob = new Blob(['HL2DEMO\0test']);
	const share = {
		id: crypto.randomUUID(),
		name: 'x.dem',
		size: blob.size,
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + contracts.SHARE_LIFETIME_MS).toISOString()
	};
	const deleteToken = crypto.randomUUID();
	let puts = 0;
	let completions = 0;
	let starts = 0;
	const progress = [];
	globalThis.fetch = async (url, options) => {
		if (url === '/api/shares') {
			starts++;
			return Response.json({
				token,
				id: share.id,
				deleteToken,
				partSize: contracts.SHARE_PART_SIZE
			});
		}
		if (options.method === 'PUT') {
			assert.equal(await options.body.text(), await blob.text());
			if (++puts === 1) return new Response('try again', { status: 503 });
			return Response.json({ partNumber: 1, etag: 'a'.repeat(32) });
		}
		if (++completions === 1)
			return new Response('{', { headers: { 'Content-Type': 'application/json' } });
		if (completions === 2) throw new TypeError('lost response');
		return Response.json(share);
	};
	try {
		assert.deepEqual(
			await client.uploadDemo(
				{ id: crypto.randomUUID(), name: 'x.dem', blob },
				'/api/shares',
				new AbortController().signal,
				(value) => progress.push(value)
			),
			{ ...share, deleteToken }
		);
		assert.equal(starts, 1);
		assert.equal(puts, 2);
		assert.equal(completions, 3);
		assert.equal(progress.at(-1), 100);
	} finally {
		globalThis.fetch = nativeFetch;
	}
});

test('lost or unsuccessful creation responses never allocate additional sessions automatically', async () => {
	const nativeFetch = globalThis.fetch;
	try {
		for (const failure of ['network', 'json', 'server']) {
			const before = (await bucket.list({ prefix: 'uploads/' })).objects.length;
			let starts = 0;
			let allocations = 0;
			const storage = new Proxy(bucket, {
				get(target, property) {
					if (property === 'createMultipartUpload')
						return (...args) => {
							allocations++;
							return target.createMultipartUpload(...args);
						};
					const value = Reflect.get(target, property);
					return typeof value === 'function' ? value.bind(target) : value;
				}
			});
			globalThis.fetch = async (input, options) => {
				const url = new URL(String(input), 'https://example.com');
				if (url.origin !== 'https://example.com') return nativeFetch(input, options);
				assert.equal(url.pathname, '/api/shares', 'No file parts may be sent without credentials');
				starts++;
				const headers = new Headers(options.headers);
				headers.set('Origin', url.origin);
				const response = await createApi.POST({
					request: new Request(url, { ...options, headers }),
					url,
					platform: { env: { SHARED_DEMOS: storage } }
				});
				assert.equal(response.status, 201);
				await response.body.cancel();
				if (failure === 'network') throw new TypeError('Lost creation response');
				if (failure === 'json')
					return new Response('{', { headers: { 'Content-Type': 'application/json' } });
				return Response.json({ message: 'Creation response unavailable' }, { status: 503 });
			};
			await assert.rejects(
				client.uploadDemo(
					{ id: crypto.randomUUID(), name: 'lost-creation.dem', blob: new Blob(['HL2DEMO\0']) },
					'/api/shares',
					new AbortController().signal,
					() => {}
				)
			);
			assert.equal(starts, 1, `${failure}: creation must not be retried`);
			assert.equal(allocations, 1);
			globalThis.fetch = nativeFetch;
			assert.equal((await bucket.list({ prefix: 'uploads/' })).objects.length, before + 1);
		}
	} finally {
		globalThis.fetch = nativeFetch;
	}
});

test('client cancellation aborts unfinished multipart data', async () => {
	const nativeFetch = globalThis.fetch;
	const controller = new AbortController();
	let aborted = false;
	let deleteUrl = '';
	globalThis.fetch = async (url, options) => {
		if (url === '/api/shares')
			return Response.json({
				token: crypto.randomUUID(),
				id: crypto.randomUUID(),
				deleteToken: crypto.randomUUID(),
				partSize: contracts.SHARE_PART_SIZE
			});
		if (options.method === 'DELETE') {
			aborted = true;
			deleteUrl = String(url);
			return new Response(null, { status: 204 });
		}
		controller.abort();
		throw new DOMException('Cancelled', 'AbortError');
	};
	try {
		await assert.rejects(
			client.uploadDemo(
				{ id: crypto.randomUUID(), name: 'x.dem', blob: new Blob(['HL2DEMO\0']) },
				'/api/shares',
				controller.signal,
				() => {}
			),
			{ name: 'AbortError' }
		);
		assert.equal(aborted, true);
		assert.match(deleteUrl, /\?cancel=1$/);
	} finally {
		globalThis.fetch = nativeFetch;
	}
});

test('a failed upload awaits cancellation cleanup even without an explicit Cancel', async () => {
	const nativeFetch = globalThis.fetch;
	let deleteUrl = '';
	globalThis.fetch = async (url, options) => {
		if (url === '/api/shares')
			return Response.json({
				token: crypto.randomUUID(),
				id: crypto.randomUUID(),
				deleteToken: crypto.randomUUID(),
				partSize: contracts.SHARE_PART_SIZE
			});
		if (options?.method === 'DELETE') {
			deleteUrl = String(url);
			return new Response(null, { status: 204 });
		}
		return Response.json({ message: 'Upload failed.' }, { status: 400 });
	};
	try {
		await assert.rejects(
			client.uploadDemo(
				{ id: crypto.randomUUID(), name: 'x.dem', blob: new Blob(['HL2DEMO\0']) },
				'/api/shares',
				new AbortController().signal,
				() => {}
			),
			/Upload failed/
		);
		assert.match(deleteUrl, /\/api\/shares\/[a-f0-9-]+\?cancel=1$/);
	} finally {
		globalThis.fetch = nativeFetch;
	}
});

test('cancellation cleanup retries failed HTTP responses and network errors', async () => {
	const nativeFetch = globalThis.fetch;
	let attempts = 0;
	globalThis.fetch = async (_, options) => {
		assert.equal(options.method, 'DELETE');
		assert.equal(options.signal.aborted, false);
		assert.equal(options.keepalive, true);
		attempts++;
		if (attempts === 1) return new Response('Temporary failure', { status: 503 });
		if (attempts === 2) throw new TypeError('Network failure');
		return new Response(null, { status: 204 });
	};
	try {
		await client.cleanupUpload({
			url: '/api/shares/test?cancel=1',
			deleteUrl: '/api/shared-demos/test',
			deleteToken: crypto.randomUUID()
		});
		assert.equal(attempts, 3);
	} finally {
		globalThis.fetch = nativeFetch;
	}
});

test('session IDs alone cannot upload, recover owner credentials, or delete a published demo', async () => {
	const { share, token, session } = await uploadBytes(new TextEncoder().encode('HL2DEMO\0owner'));
	assert.ok(session.deleteProof);
	assert.equal(session.deleteToken, undefined);
	assert.ok(!JSON.stringify(session).includes(share.deleteToken));
	for (const method of ['PUT', 'POST', 'DELETE']) {
		for (const secret of ['', token, share.id, crypto.randomUUID()]) {
			const url = new URL(`https://example.com/api/shares/${token}?cancel=1&part=1`);
			await assert.rejects(
				uploadApi[method]({
					request: new Request(url, {
						method,
						headers: { Origin: url.origin, Authorization: `Bearer ${secret}` }
					}),
					url,
					params: { token },
					platform: { env: { SHARED_DEMOS: bucket } }
				}),
				{ status: 403 }
			);
		}
	}
	assert.equal((await downloads.HEAD(downloadEvent(share.id))).status, 200);
});

test('all lost completion responses trigger authenticated cancellation instead of leaving an orphan', async () => {
	const nativeFetch = globalThis.fetch;
	let started;
	let completions = 0;
	let cancels = 0;
	globalThis.fetch = async (input, options = {}) => {
		const url = new URL(String(input), 'https://example.com');
		if (url.origin !== 'https://example.com' || !url.pathname.startsWith('/api/'))
			return nativeFetch(input, options);
		const headers = new Headers(options.headers);
		headers.set('Origin', url.origin);
		const event = {
			request: new Request(url, { ...options, headers }),
			url,
			params: {},
			platform: { env: { SHARED_DEMOS: bucket } }
		};
		if (url.pathname === '/api/shares') {
			const response = await createApi.POST(event);
			started = await response.clone().json();
			return response;
		}
		assert.equal(headers.get('Authorization'), `Bearer ${started.deleteToken}`);
		assert.ok(!url.href.includes(started.deleteToken));
		event.params.token = started.token;
		const response = await uploadApi[options.method](event);
		if (options.method === 'POST') {
			completions++;
			assert.equal((await response.json()).deleteToken, undefined);
			throw new TypeError('Lost completion response');
		}
		if (options.method === 'DELETE') cancels++;
		return response;
	};
	try {
		await assert.rejects(
			client.uploadDemo(
				{ id: crypto.randomUUID(), name: 'lost.dem', blob: new Blob(['HL2DEMO\0']) },
				'/api/shares',
				new AbortController().signal,
				() => {}
			),
			/Lost completion response/
		);
		assert.equal(completions, 3);
		assert.equal(cancels, 1);
		assert.equal((await downloads.HEAD(downloadEvent(started.id))).status, 404);
		assert.equal((await server.getUpload(bucket, started.token)).cancelled, true);
	} finally {
		globalThis.fetch = nativeFetch;
	}
});

test(
	'stalled cleanup attempts time out, abort, and retain credentials for a later retry',
	{ timeout: 2000 },
	async (t) => {
		const nativeFetch = globalThis.fetch;
		const nativeSetTimeout = globalThis.setTimeout;
		t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
			nativeSetTimeout(callback, Math.min(delay, 5), ...args)
		);
		const signals = [];
		globalThis.fetch = (_, options) => {
			signals.push(options.signal);
			return new Promise(() => {});
		};
		const cleanup = {
			url: '/api/shares/session?cancel=1',
			deleteUrl: '/api/shared-demos/demo',
			deleteToken: crypto.randomUUID()
		};
		try {
			await assert.rejects(client.cleanupUpload(cleanup), (cause) => {
				assert.ok(cause instanceof client.UploadCleanupError);
				assert.deepEqual(cause.cleanup, cleanup);
				return true;
			});
			assert.equal(signals.length, 3);
			assert.equal(new Set(signals).size, 3);
			assert.ok(signals.every((signal) => signal.aborted));
			globalThis.fetch = async (_, options) => {
				assert.equal(options.headers.Authorization, `Bearer ${cleanup.deleteToken}`);
				return new Response(null, { status: 204 });
			};
			await client.cleanupUpload(cleanup);
		} finally {
			globalThis.fetch = nativeFetch;
		}
	}
);

test('cleanup can still revoke a completed demo after its upload session expires or is removed', async () => {
	const nativeFetch = globalThis.fetch;
	try {
		for (const expired of [false, true]) {
			const { share, token } = await uploadBytes(
				new TextEncoder().encode('HL2DEMO\0expired-session')
			);
			const key = `uploads/${token}.json`;
			if (expired) {
				const session = await server.getUpload(bucket, token);
				await bucket.put(key, JSON.stringify({ ...session, startedAt: Date.now() - 86400000 }));
			} else await bucket.delete(key);
			globalThis.fetch = async (input, options) => {
				const url = new URL(String(input), 'https://example.com');
				if (url.origin !== 'https://example.com' || !url.pathname.startsWith('/api/'))
					return nativeFetch(input, options);
				const headers = new Headers(options.headers);
				headers.set('Origin', url.origin);
				const event = {
					request: new Request(url, { ...options, headers }),
					url,
					params: { token, id: share.id },
					platform: { env: { SHARED_DEMOS: bucket } }
				};
				try {
					return url.pathname.startsWith('/api/shares/')
						? await uploadApi.DELETE(event)
						: await deleteApi.DELETE(event);
				} catch (cause) {
					if (isHttpError(cause)) return Response.json(cause.body, { status: cause.status });
					throw cause;
				}
			};
			await client.cleanupUpload({
				url: `/api/shares/${token}?cancel=1`,
				deleteUrl: `/api/shared-demos/${share.id}`,
				deleteToken: share.deleteToken
			});
			assert.equal((await downloads.HEAD(downloadEvent(share.id))).status, 404);
		}
	} finally {
		globalThis.fetch = nativeFetch;
	}
});
