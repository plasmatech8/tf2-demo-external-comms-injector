import { demoKey, getShareBucket, savedShare } from '$lib/server/shares';
import { SHARE_ID_PATTERN, SHARE_LIFETIME_DAYS } from '$lib/shares';
import type { RequestHandler } from './$types';

const failure = (message: string, status: number) =>
	new Response(message, {
		status,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Robots-Tag': 'noindex, nofollow'
		}
	});

const download: RequestHandler = async ({ platform, params, request }) => {
	if (!SHARE_ID_PATTERN.test(params.id)) return failure('This demo link is invalid.', 404);
	const bucket = getShareBucket(platform);
	const bodyObject = request.method === 'HEAD' ? null : await bucket.get(demoKey(params.id));
	const object = request.method === 'HEAD' ? await bucket.head(demoKey(params.id)) : bodyObject;
	if (!object)
		return failure(
			`This demo link has expired or is no longer available. Links last ${SHARE_LIFETIME_DAYS} days.`,
			404
		);
	const share = savedShare(object);
	if (Date.parse(share.expiresAt) <= Date.now()) {
		if (bodyObject) await bodyObject.body.cancel();
		return failure(
			`This demo link has expired. Share links last ${SHARE_LIFETIME_DAYS} days.`,
			410
		);
	}
	const headers = new Headers({
		'Content-Type': 'application/octet-stream',
		'Content-Length': String(object.size),
		'Content-Disposition': `attachment; filename="demo_with_comms.dem"; filename*=UTF-8''${encodeURIComponent(share.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
		'Cache-Control': 'private, no-store',
		'X-Content-Type-Options': 'nosniff',
		'X-Robots-Tag': 'noindex, nofollow',
		'Referrer-Policy': 'no-referrer'
	});
	return new Response(bodyObject?.body ?? null, { headers });
};

export const GET = download;
export const HEAD = download;
