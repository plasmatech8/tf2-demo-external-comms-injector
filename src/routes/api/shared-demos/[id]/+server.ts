import { deleteSharedDemo, getShareBucket, requireSameOrigin } from '$lib/server/shares';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ request, url, platform, params }) => {
	requireSameOrigin(request, url);
	const authorization = request.headers.get('Authorization') ?? '';
	await deleteSharedDemo(
		getShareBucket(platform),
		params.id,
		authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
	);
	return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
};
