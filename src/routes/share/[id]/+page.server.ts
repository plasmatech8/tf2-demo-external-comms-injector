import { error } from '@sveltejs/kit';
import { getSharedDemoInfo } from '$lib/server/shares';
import { SITE_NAME } from '$lib/site';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, params, setHeaders }) => {
	setHeaders({
		'Cache-Control': 'private, no-store',
		'X-Robots-Tag': 'noindex, nofollow',
		'Referrer-Policy': 'no-referrer'
	});
	const bucket = platform?.env.SHARED_DEMOS;
	if (!bucket) error(503, 'Demo downloads are temporarily unavailable. Please try again later.');
	return {
		share: await getSharedDemoInfo(bucket, params.id),
		checkedAt: Date.now(),
		title: `Download demo — ${SITE_NAME}`,
		description: 'Download a shared TF2 demo with synced voice comms.'
	};
};
