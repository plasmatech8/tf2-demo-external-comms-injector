import { MAX_SHARE_SIZE, SHARE_SIZE_ERROR, type GeneratedDemo, type SavedShare } from './shares';

export interface UploadCleanup {
	url: string;
	deleteUrl: string;
	deleteToken: string;
}

export class UploadCleanupError extends Error {
	constructor(public readonly cleanup: UploadCleanup) {
		super('Could not finish cancelling the upload. Retry cancellation before leaving this page.');
	}
}

export async function cleanupUpload(cleanup: UploadCleanup) {
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) await new Promise((done) => setTimeout(done, 500 * attempt));
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error('Upload cleanup timed out.'));
				}, 10_000);
			});
			const remove = async () => {
				const options = {
					method: 'DELETE',
					keepalive: true,
					headers: { Authorization: `Bearer ${cleanup.deleteToken}` },
					signal: controller.signal
				};
				let response = await fetch(cleanup.url, options);
				void response.body?.cancel().catch(() => undefined);
				// The session can expire before the demo. The owner key still permits
				// deleting that demo even when its multipart session is no longer there.
				if (response.status === 404 || response.status === 410) {
					response = await fetch(cleanup.deleteUrl, options);
					void response.body?.cancel().catch(() => undefined);
				}
				return response.ok || response.status === 404;
			};
			if (await Promise.race([remove(), deadline])) return;
		} catch {
			/* Retry network failures as well as unsuccessful cleanup responses. */
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}
	throw new UploadCleanupError(cleanup);
}

async function requestJson<T>(url: string, options: RequestInit, attempts = 3): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		if (attempt > 0) await new Promise((done) => setTimeout(done, 500 * attempt));
		options.signal?.throwIfAborted();
		let response: Response;
		try {
			response = await fetch(url, options);
		} catch (cause) {
			if (options.signal?.aborted || attempt + 1 >= attempts) throw cause;
			continue;
		}
		if (!response.ok) {
			if (attempt + 1 < attempts && response.status >= 500) {
				await response.body?.cancel();
				continue;
			}
			let message = `Upload failed (${response.status}). Please try again.`;
			try {
				const body = (await response.json()) as { message?: string };
				if (body.message) message = body.message;
			} catch {
				/* An intermediary may return a non-JSON error. */
			}
			throw new Error(message);
		}
		try {
			return (await response.json()) as T;
		} catch (cause) {
			if (options.signal?.aborted || attempt + 1 >= attempts) throw cause;
		}
	}
}

export async function uploadDemo(
	demo: GeneratedDemo,
	apiUrl: string,
	signal: AbortSignal,
	onProgress: (percent: number) => void
): Promise<SavedShare> {
	if (demo.blob.size > MAX_SHARE_SIZE) throw new Error(SHARE_SIZE_ERROR);
	const session = await requestJson<{
		token: string;
		id: string;
		deleteToken: string;
		partSize: number;
	}>(
		apiUrl,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: demo.name, size: demo.blob.size }),
			signal
		},
		// Creation allocates new credentials and a multipart upload on each call.
		// A lost response must not trigger additional allocations automatically.
		1
	);
	const sessionUrl = `${apiUrl}/${session.token}`;
	const headers = { Authorization: `Bearer ${session.deleteToken}` };
	const cleanup = {
		url: `${sessionUrl}?cancel=1`,
		deleteUrl: `${apiUrl.replace(/\/shares$/, '/shared-demos')}/${session.id}`,
		deleteToken: session.deleteToken
	};
	try {
		const parts: { partNumber: number; etag: string }[] = [];
		for (let offset = 0; offset < demo.blob.size; offset += session.partSize) {
			parts.push(
				await requestJson(`${sessionUrl}?part=${parts.length + 1}`, {
					method: 'PUT',
					headers: { ...headers, 'Content-Type': 'application/octet-stream' },
					body: demo.blob.slice(offset, offset + session.partSize),
					signal
				})
			);
			onProgress(Math.min(95, ((offset + session.partSize) / demo.blob.size) * 95));
		}
		const share = await requestJson<SavedShare>(sessionUrl, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({ parts }),
			signal
		});
		onProgress(100);
		return { ...share, deleteToken: session.deleteToken };
	} catch (cause) {
		// Once retries are exhausted, discard even a completed demo whose response
		// never arrived. Keep its owner key available if cleanup itself needs retrying.
		await cleanupUpload(cleanup);
		throw cause;
	}
}
