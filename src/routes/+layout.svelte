<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>TF2 Demo File — External Comms Audio Injection Tool</title>
	<meta
		name="description"
		content="Inject external audio into a TF2 demo as in-game voice chat so gameplay and comms stay in sync in the built-in demo player—even when you change playback speed."
	/>
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
