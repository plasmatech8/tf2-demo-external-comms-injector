import { error, json } from '@sveltejs/kit';
import {
	MAX_SHARE_SIZE,
	MAX_SHARE_NAME_LENGTH,
	SHARE_ID_PATTERN,
	SHARE_LIFETIME_MS,
	SHARE_PART_SIZE,
	SHARE_SIZE_ERROR,
	type SavedShare
} from '$lib/shares';

const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;

interface UploadSession {
	id: string;
	name: string;
	size: number;
	uploadId: string;
	startedAt: number;
	deleteToken?: string;
	deleteProof?: string;
	cancelled?: boolean;
}

export function getShareBucket(platform: App.Platform | undefined): R2Bucket {
	const bucket = platform?.env.SHARED_DEMOS;
	if (!bucket)
		error(503, 'Demo sharing is not configured yet. Your downloaded demo is still available.');
	return bucket;
}

export function requireSameOrigin(request: Request, url: URL) {
	if (request.headers.get('origin') !== url.origin) error(403, 'Upload from this website only.');
}

export function shareJson(value: unknown, status = 200) {
	return json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Bound JSON before parsing; multipart data has its own fixed part size. */
export async function readShareJson(request: Request): Promise<Record<string, unknown>> {
	if (!request.headers.get('content-type')?.startsWith('application/json')) {
		error(415, 'Expected JSON.');
	}
	if (!request.body) error(400, 'Missing request body.');
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > 32 * 1024) {
			await reader.cancel();
			error(413, 'Request too large.');
		}
		chunks.push(value);
	}
	try {
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	} catch {
		/* Invalid JSON is handled below. */
	}
	error(400, 'Invalid JSON.');
}

export const demoKey = (id: string) => `demos/${id}.dem`;
const sessionKey = (token: string) => `uploads/${token}.json`;

async function uploadWasCancelled(bucket: R2Bucket, token: string) {
	const object = await bucket.get(sessionKey(token));
	return !object || !!(await object.json<UploadSession>()).cancelled;
}

export function savedShare(object: R2Object): SavedShare {
	return {
		id: object.key.slice('demos/'.length, -'.dem'.length),
		name: object.customMetadata?.name ?? 'demo_with_comms.dem',
		size: object.size,
		createdAt: object.uploaded.toISOString(),
		expiresAt: new Date(object.uploaded.getTime() + SHARE_LIFETIME_MS).toISOString()
	};
}

/** Read metadata only; visiting a shared page must not stream the demo. */
export async function getSharedDemoInfo(bucket: R2Bucket, id: string, now = Date.now()) {
	if (!SHARE_ID_PATTERN.test(id)) error(404, 'This demo link is invalid.');
	const object = await bucket.head(demoKey(id));
	if (!object) error(404, 'This link has expired or the demo is no longer available.');
	const share = savedShare(object);
	if (Date.parse(share.expiresAt) <= now) error(410, 'This share link has expired.');
	return share;
}

export async function startShare(bucket: R2Bucket, body: Record<string, unknown>) {
	if (
		typeof body.name !== 'string' ||
		!body.name.toLowerCase().endsWith('.dem') ||
		typeof body.size !== 'number' ||
		!Number.isSafeInteger(body.size) ||
		body.size < 8
	)
		error(400, 'Choose a generated .dem file.');
	if (body.size > MAX_SHARE_SIZE) error(413, SHARE_SIZE_ERROR);
	const name =
		Array.from(body.name, (char) => {
			const code = char.charCodeAt(0);
			return code < 32 ||
				code === 127 ||
				char === '/' ||
				char === '\\' ||
				(char.length === 1 && code >= 0xd800 && code <= 0xdfff)
				? '_'
				: char;
		})
			.slice(0, MAX_SHARE_NAME_LENGTH - '.dem'.length)
			.join('')
			.replace(/\.dem$/i, '') + '.dem';
	const id = crypto.randomUUID();
	// The upload capability is separate from the public download ID.
	const token = crypto.randomUUID();
	const deleteToken = crypto.randomUUID();
	const deleteKey = await deletionKey(deleteToken, ['sign']);
	const proof = new Uint8Array(
		await crypto.subtle.sign('HMAC', deleteKey, new TextEncoder().encode(id))
	);
	const deleteProof = Array.from(proof, (byte) => byte.toString(16).padStart(2, '0')).join('');
	const upload = await bucket.createMultipartUpload(demoKey(id), {
		httpMetadata: { contentType: 'application/octet-stream' },
		customMetadata: { name, deleteProof }
	});
	const session: UploadSession = {
		id,
		name,
		size: body.size,
		uploadId: upload.uploadId,
		startedAt: Date.now(),
		deleteProof
	};
	try {
		await bucket.put(sessionKey(token), JSON.stringify(session), {
			httpMetadata: { contentType: 'application/json' }
		});
	} catch (cause) {
		await upload.abort().catch(() => undefined);
		throw cause;
	}
	return { token, id, deleteToken, partSize: SHARE_PART_SIZE };
}

/** A session ID in an access log must not grant upload or deletion authority. */
export async function requireUploadOwner(session: UploadSession, request: Request) {
	const authorization = request.headers.get('Authorization') ?? '';
	const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
	let proof = session.deleteProof;
	// Sessions made by an older local build stored the key rather than its proof.
	if (!proof && session.deleteToken) {
		const key = await deletionKey(session.deleteToken, ['sign']);
		const signature = new Uint8Array(
			await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(session.id))
		);
		proof = Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
	}
	if (!(await verifyDeletionKey(session.id, proof, token)))
		error(403, 'This browser cannot manage this upload.');
}

export async function getUpload(bucket: R2Bucket, token: string) {
	if (!SHARE_ID_PATTERN.test(token)) error(404, 'Upload not found.');
	const object = await bucket.get(sessionKey(token));
	if (!object) error(404, 'Upload not found. Please try again.');
	const session = await object.json<UploadSession>();
	if (Date.now() - session.startedAt >= UPLOAD_LIFETIME_MS) {
		error(410, 'Upload expired. Please try again.');
	}
	return session;
}

export async function uploadSharePart(
	bucket: R2Bucket,
	session: UploadSession,
	part: number,
	request: Request
) {
	if (session.cancelled) error(409, 'Upload cancelled.');
	const count = Math.ceil(session.size / SHARE_PART_SIZE);
	if (!Number.isInteger(part) || part < 1 || part > count) error(400, 'Invalid upload part.');
	const size = Math.min(SHARE_PART_SIZE, session.size - (part - 1) * SHARE_PART_SIZE);
	if (!request.body) error(400, 'Missing upload part.');
	// Development proxies may omit Content-Length. Bound the actual stream rather
	// than trusting that header, with at most one fixed-size part held in memory.
	const bytes = new Uint8Array(size);
	const reader = request.body.getReader();
	let offset = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (offset + value.byteLength > size) {
			await reader.cancel();
			error(413, 'Upload part is too large.');
		}
		bytes.set(value, offset);
		offset += value.byteLength;
	}
	if (offset !== size) error(400, 'Incomplete upload part.');
	if (part === 1 && new TextDecoder().decode(bytes.subarray(0, 8)) !== 'HL2DEMO\0') {
		error(400, 'This file is not a Source demo.');
	}
	return bucket
		.resumeMultipartUpload(demoKey(session.id), session.uploadId)
		.uploadPart(part, bytes);
}

export async function completeShare(
	bucket: R2Bucket,
	session: UploadSession,
	body: Record<string, unknown>,
	token?: string
) {
	if (session.cancelled || (token && (await uploadWasCancelled(bucket, token))))
		error(409, 'Upload cancelled.');
	const parts = body.parts;
	if (!Array.isArray(parts) || parts.length !== Math.ceil(session.size / SHARE_PART_SIZE)) {
		error(400, 'Upload is incomplete.');
	}
	const validated: R2UploadedPart[] = parts.map((part: unknown, index: number) => {
		if (!part || typeof part !== 'object') error(400, 'Invalid upload part.');
		const { partNumber, etag } = part as Partial<R2UploadedPart>;
		if (partNumber !== index + 1 || typeof etag !== 'string' || !/^[!-~]{1,256}$/.test(etag)) {
			error(400, 'Invalid upload part.');
		}
		return { partNumber, etag };
	});
	// A retry after a lost completion response returns the same link.
	let object = await bucket.head(demoKey(session.id));
	if (!object) {
		object = await bucket
			.resumeMultipartUpload(demoKey(session.id), session.uploadId)
			.complete(validated);
	}
	if (object.size !== session.size) {
		await bucket.delete(demoKey(session.id));
		error(400, 'Upload size did not match the generated demo. Please try again.');
	}
	// Re-read after completion: Cancel may have marked this session in the meantime.
	if (token && (await uploadWasCancelled(bucket, token))) {
		await bucket.delete(demoKey(session.id));
		error(409, 'Upload cancelled.');
	}
	return savedShare(object);
}

function deletionKey(token: string, usage: KeyUsage[]) {
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(token),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		usage
	);
}

async function verifyDeletionKey(id: string, proof: string | undefined, token: string) {
	if (!SHARE_ID_PATTERN.test(token) || !proof || !/^[a-f0-9]{64}$/.test(proof)) return false;
	const signature = Uint8Array.from(proof.match(/../g)!, (byte) => Number.parseInt(byte, 16));
	const key = await deletionKey(token, ['verify']);
	return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(id));
}

/** The public demo ID alone never authorizes deletion. */
export async function deleteSharedDemo(bucket: R2Bucket, id: string, token: string) {
	if (!SHARE_ID_PATTERN.test(id)) error(404, 'This demo link is invalid.');
	if (!SHARE_ID_PATTERN.test(token)) error(403, 'This browser cannot delete this shared demo.');
	const object = await bucket.head(demoKey(id));
	// Retrying a successful deletion (or cleaning up an expired link) is harmless.
	if (!object) return;
	const proof = object.customMetadata?.deleteProof;
	if (!proof || !/^[a-f0-9]{64}$/.test(proof))
		error(403, 'This older link has no deletion key. It remains available until expiry.');
	if (!(await verifyDeletionKey(id, proof, token)))
		error(403, 'This browser cannot delete this shared demo.');
	await bucket.delete(demoKey(id));
}

export async function abortShare(
	bucket: R2Bucket,
	session: UploadSession,
	token: string,
	discardCompleted = false
) {
	// Keep the capability and cancellation marker even if storage cleanup fails.
	// Repeated Cancel requests can retry, and in-flight completion sees the marker.
	const cancelled = discardCompleted || session.cancelled;
	if (cancelled) {
		await bucket.put(sessionKey(token), JSON.stringify({ ...session, cancelled: true }), {
			httpMetadata: { contentType: 'application/json' }
		});
	}
	await bucket
		.resumeMultipartUpload(demoKey(session.id), session.uploadId)
		.abort()
		.catch(() => undefined);
	// Retain cancelled sessions until their existing one-day lifecycle cleanup so
	// retries after a lost response are idempotent and cannot resume the upload.
	if (cancelled) await bucket.delete(demoKey(session.id));
	else await bucket.delete(sessionKey(token));
}
