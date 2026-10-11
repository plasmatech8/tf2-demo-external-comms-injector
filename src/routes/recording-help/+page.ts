import { SITE_NAME } from '$lib/site';
import type { PageLoad } from './$types';

export const load: PageLoad = () => ({
	title: `Recording help — ${SITE_NAME}`,
	description:
		'Simple tips for recording full-match comms with Medal, OBS, or the Craig Discord bot, and syncing them with a TF2 demo.'
});
