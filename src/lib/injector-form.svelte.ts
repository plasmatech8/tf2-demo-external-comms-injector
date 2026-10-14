import { createContext } from 'svelte';
import type { DemoPlayer } from '$lib/demo/players';
import type { MediaInspection } from '$lib/media/tracks';

/** Injector form fields that should survive in-app navigation (e.g. Recording help). */
export class InjectorForm {
	demoFile = $state<File | null>(null);
	mediaFile = $state<File | null>(null);
	/** Seconds into the media until first round start. Defaults to 5. */
	mediaGameStart = $state<number | null>(5);
	/** String draft for the game-start field so typing isn't rewritten by toFixed. */
	gameStartDraft = $state('5.0');
	selectedPlayerId = $state('');
	selectedSources = $state<string[]>([]);
	successMessage = $state<string | null>(null);
	errorMessage = $state<string | null>(null);
	players = $state<DemoPlayer[]>([]);
	playersLoading = $state(false);
	playersError = $state<string | null>(null);
	mediaInfo = $state<MediaInspection | null>(null);
	mediaLoading = $state(false);
	mediaError = $state<string | null>(null);
	/** Bumped to ignore stale async demo completions. */
	demoLoadGen = $state(0);
	/** Bumped to ignore stale async media completions. */
	mediaLoadGen = $state(0);
	/** True after the injector page has painted once — skip the fade on return. */
	injectorVisited = $state(false);
}

export function createInjectorForm(): InjectorForm {
	return new InjectorForm();
}

export const [getInjectorForm, setInjectorForm] = createContext<InjectorForm>();
