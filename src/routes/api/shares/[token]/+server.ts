import {
	abortShare,
	completeShare,
	getShareBucket,
	getUpload,
	readShareJson,
	requireSameOrigin,
	requireUploadOwner,
	shareJson,
	uploadSharePart
} from '$lib/server/shares';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ request, url, platform, params }) => {
	requireSameOrigin(request, url);
	const bucket = getShareBucket(platform);
	const session = await getUpload(bucket, params.token);
	await requireUploadOwner(session, request);
	return shareJson(
		await uploadSharePart(bucket, session, Number(url.searchParams.get('part')), request)
	);
};

export const POST: RequestHandler = async ({ request, url, platform, params }) => {
	requireSameOrigin(request, url);
	const bucket = getShareBucket(platform);
	const session = await getUpload(bucket, params.token);
	await requireUploadOwner(session, request);
	return shareJson(
		await completeShare(bucket, session, await readShareJson(request), params.token)
	);
};

export const DELETE: RequestHandler = async ({ request, url, platform, params }) => {
	requireSameOrigin(request, url);
	const bucket = getShareBucket(platform);
	const session = await getUpload(bucket, params.token);
	await requireUploadOwner(session, request);
	await abortShare(bucket, session, params.token, url.searchParams.get('cancel') === '1');
	return new Response(null, { status: 204 });
};
