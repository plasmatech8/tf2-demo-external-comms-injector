<script lang="ts">
	import './layout.css';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import { createInjectorForm, setInjectorForm } from '$lib/injector-form.svelte';
	import { META_DESCRIPTION, OG_IMAGE_PATH, SITE_TITLE } from '$lib/site';

	let { children } = $props();

	const form = createInjectorForm();
	setInjectorForm(form);

	const hasUpload = $derived(!!form.demoFile || !!form.mediaFile);

	/** Soft-blocks tab close / refresh / leaving the site while files are selected. */
	function onBeforeUnload(event: BeforeUnloadEvent) {
		event.preventDefault();
		event.returnValue = '';
	}

	const canonicalUrl = $derived(`${page.url.origin}${page.url.pathname}`);
	const ogImageUrl = $derived(`${page.url.origin}${OG_IMAGE_PATH}`);
	const pageTitle = $derived(page.data.title ?? SITE_TITLE);
	const pageDescription = $derived(page.data.description ?? META_DESCRIPTION);
</script>

<svelte:window onbeforeunload={hasUpload ? onBeforeUnload : undefined} />

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>{pageTitle}</title>
	<meta name="description" content={pageDescription} />
	<link rel="canonical" href={canonicalUrl} />

	<meta property="og:type" content="website" />
	<meta property="og:url" content={canonicalUrl} />
	<meta property="og:title" content={pageTitle} />
	<meta property="og:description" content={pageDescription} />
	<meta property="og:image" content={ogImageUrl} />
	<meta property="og:locale" content="en_US" />

	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content={pageTitle} />
	<meta name="twitter:description" content={pageDescription} />
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
