import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ platform }) => ({
	sharingEnabled: !!platform?.env.SHARED_DEMOS
});
