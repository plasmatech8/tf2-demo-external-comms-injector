import { error } from '@sveltejs/kit';
import {
	getShareBucket,
	readShareJson,
	requireSameOrigin,
	shareJson,
	startShare
} from '$lib/server/shares';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url, platform }) => {
	requireSameOrigin(request, url);
	const bucket = getShareBucket(platform);
	const limiter = platform?.env.SHARE_UPLOAD_LIMITER;
	if (
		limiter &&
		!(await limiter.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })).success
	) {
		error(429, 'Too many share uploads. Please wait a minute and try again.');
	}
	return shareJson(await startShare(bucket, await readShareJson(request)), 201);
};
