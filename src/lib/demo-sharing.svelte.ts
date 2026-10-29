import { resolve } from '$app/paths';
import { cleanupUpload, uploadDemo, UploadCleanupError, type UploadCleanup } from './share-upload';
import {
	readSavedShares,
	retainSavedShares,
	shareIsExpired,
	type GeneratedDemo,
	type SavedShare
} from './shares';

const STORAGE_KEY = 'tf2-demo-share-links-v1';

export function createDemoSharing() {
	const state = $state({
		shares: [] as SavedShare[],
		uploading: false,
		progress: 0,
		cleanupError: '',
		cleanupRetrying: false,
		deletingId: '',
		deleteError: '',
		error: '',
		errorDemoId: '',
		storageWarning: '',
		copyMessage: '',
		copiedId: '',
		expanded: false,
		sharedDemoId: '',
		currentShare: null as SavedShare | null,
		now: Date.now()
	});
	let uploadAbort: AbortController | null = null;
	let pendingCleanup: UploadCleanup | null = null;
	let copyTimeout: ReturnType<typeof setTimeout> | undefined;

	function mount() {
		function loadHistory() {
			try {
				state.shares = readSavedShares(localStorage.getItem(STORAGE_KEY));
				if (
					state.currentShare?.deleteToken &&
					!state.shares.some((share) => share.id === state.currentShare?.id)
				) {
					state.currentShare = null;
					state.sharedDemoId = '';
				}
			} catch {
				state.storageWarning =
					'Your saved links could not be read. New links will still appear here.';
			}
		}
		loadHistory();
		const timer = window.setInterval(() => {
			state.now = Date.now();
		}, 60_000);
		const onStorage = (event: StorageEvent) => {
			if (event.key === STORAGE_KEY || event.key === null) loadHistory();
		};
		window.addEventListener('storage', onStorage);
		return () => {
			uploadAbort?.abort();
			clearTimeout(copyTimeout);
			clearInterval(timer);
			window.removeEventListener('storage', onStorage);
		};
	}

	function saveHistory(next: SavedShare[]) {
		state.shares = retainSavedShares(next);
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(state.shares));
			state.storageWarning = '';
		} catch {
			state.storageWarning =
				'This browser could not save your link list. Copy any links you want to keep before leaving.';
		}
	}

	function isShared(demo: GeneratedDemo | null) {
		return (
			!!demo &&
			state.sharedDemoId === demo.id &&
			!!state.currentShare &&
			!shareIsExpired(state.currentShare, state.now)
		);
	}

	function isSaved(demo: GeneratedDemo | null) {
		return isShared(demo) && state.shares.some((share) => share.id === state.currentShare?.id);
	}

	async function createShare(demo: GeneratedDemo) {
		if (state.uploading || state.deletingId || pendingCleanup) return;
		if (isShared(demo) && state.currentShare) {
			const share = state.currentShare;
			saveHistory([share, ...state.shares.filter((item) => item.id !== share.id)]);
			state.expanded = true;
			return;
		}
		uploadAbort = new AbortController();
		const signal = uploadAbort.signal;
		state.uploading = true;
		state.progress = 0;
		state.error = '';
		state.errorDemoId = '';
		try {
			const share = await uploadDemo(demo, resolve('/api/shares'), signal, (value) => {
				state.progress = value;
			});
			let stored = state.shares;
			try {
				stored = [...stored, ...readSavedShares(localStorage.getItem(STORAGE_KEY))];
			} catch {
				/* Keep the current list when browser storage is unavailable. */
			}
			saveHistory([
				share,
				...stored.filter(
					(item, index) =>
						item.id !== share.id && stored.findIndex((other) => other.id === item.id) === index
				)
			]);
			state.currentShare = share;
			state.sharedDemoId = demo.id;
			state.expanded = true;
			state.now = Date.now();
		} catch (cause) {
			if (cause instanceof UploadCleanupError) {
				pendingCleanup = cause.cleanup;
				state.cleanupError = cause.message;
			} else if (!signal.aborted) {
				state.error = cause instanceof Error ? cause.message : 'Upload failed. Please try again.';
				state.errorDemoId = demo.id;
			}
		} finally {
			state.uploading = false;
			uploadAbort = null;
		}
	}

	async function retryCleanup() {
		if (!pendingCleanup || state.cleanupRetrying) return;
		state.cleanupRetrying = true;
		try {
			await cleanupUpload(pendingCleanup);
			pendingCleanup = null;
			state.cleanupError = '';
		} catch {
			/* Keep the capability and visible retry action until cleanup succeeds. */
		} finally {
			state.cleanupRetrying = false;
		}
	}

	async function copyLink(share: SavedShare) {
		clearTimeout(copyTimeout);
		state.copiedId = '';
		try {
			await navigator.clipboard.writeText(
				`${window.location.origin}${resolve('/share/[id]', { id: share.id })}`
			);
			state.copyMessage = 'Link copied.';
			state.copiedId = share.id;
			copyTimeout = setTimeout(() => {
				state.copiedId = '';
				state.copyMessage = '';
			}, 2000);
		} catch {
			state.copyMessage = 'Copy the link address from the demo filename.';
		}
	}

	function removeLink(id: string) {
		saveHistory(state.shares.filter((share) => share.id !== id));
	}

	function requestDelete(share: SavedShare) {
		if (state.deletingId) return;
		const message = share.deleteToken
			? `Delete "${share.name}"?\n\nThis permanently deletes the uploaded demo and removes it from your saved links. Its share link will stop working. This cannot be undone.`
			: `Remove "${share.name}" from saved links?\n\nThis only removes the entry from this browser. The uploaded demo and share link remain available until expiry.`;
		if (window.confirm(message)) return deleteShare(share);
	}

	async function deleteShare(share: SavedShare) {
		if (state.deletingId) return;
		state.deleteError = '';
		if (!share.deleteToken) {
			removeLink(share.id);
			state.storageWarning =
				'This older link was removed from history. It remains available until it expires.';
			return;
		}
		state.deletingId = share.id;
		try {
			const response = await fetch(resolve('/api/shared-demos/[id]', { id: share.id }), {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${share.deleteToken}` }
			});
			if (!response.ok) throw new Error('Could not delete the shared demo. Please try again.');
			if (state.currentShare?.id === share.id) {
				state.currentShare = null;
				state.sharedDemoId = '';
			}
			removeLink(share.id);
			if (state.copiedId === share.id) {
				state.copiedId = '';
				state.copyMessage = '';
			}
		} catch (cause) {
			state.deleteError =
				cause instanceof Error
					? cause.message
					: 'Could not delete the shared demo. Please try again.';
		} finally {
			state.deletingId = '';
		}
	}

	return {
		state,
		mount,
		isShared,
		isSaved,
		errorFor: (demo: GeneratedDemo | null) => (demo?.id === state.errorDemoId ? state.error : ''),
		createShare,
		copyLink,
		deleteShare,
		requestDelete,
		retryCleanup,
		cancelUpload: () => uploadAbort?.abort(),
		removeLink
	};
}

export type DemoSharing = ReturnType<typeof createDemoSharing>;
