<script lang="ts">
	import './layout.css';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import {
		META_DESCRIPTION,
		OG_IMAGE_PATH,
		SITE_TITLE
	} from '$lib/site';

	let { children } = $props();

	const canonicalUrl = $derived(`${page.url.origin}${page.url.pathname}`);
	const ogImageUrl = $derived(`${page.url.origin}${OG_IMAGE_PATH}`);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>{SITE_TITLE}</title>
	<meta name="description" content={META_DESCRIPTION} />
	<link rel="canonical" href={canonicalUrl} />

	<meta property="og:type" content="website" />
	<meta property="og:url" content={canonicalUrl} />
	<meta property="og:title" content={SITE_TITLE} />
	<meta property="og:description" content={META_DESCRIPTION} />
	<meta property="og:image" content={ogImageUrl} />
	<meta property="og:locale" content="en_US" />

	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content={SITE_TITLE} />
	<meta name="twitter:description" content={META_DESCRIPTION} />
	<meta name="twitter:image" content={ogImageUrl} />

	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<div id="app-root">
	{@render children()}
</div>
