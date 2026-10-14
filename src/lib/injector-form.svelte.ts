import { createContext } from 'svelte';
import type { DemoPlayer } from '$lib/demo/players';
import type { MediaInspection } from '$lib/media/tracks';

/** Injector form fields that should survive in-app navigation (e.g. Recording help). */
export type InjectorForm = {
	demoFile: File | null;
	mediaFile: File | null;
	/** Seconds into the media until first round start. Defaults to 5. */
	mediaGameStart: number | null;
	/** String draft for the game-start field so typing isn't rewritten by toFixed. */
	gameStartDraft: string;
	selectedPlayerId: string;
	selectedSources: string[];
	successMessage: string | null;
	errorMessage: string | null;
	players: DemoPlayer[];
	playersLoading: boolean;
	playersError: string | null;
	mediaInfo: MediaInspection | null;
	mediaLoading: boolean;
	mediaError: string | null;
	/** Bumped to ignore stale async demo completions. */
	demoLoadGen: number;
	/** Bumped to ignore stale async media completions. */
	mediaLoadGen: number;
	/** True after the injector page has painted once — skip the fade on return. */
	injectorVisited: boolean;
};

export function createInjectorForm(): InjectorForm {
	return $state({
		demoFile: null,
		mediaFile: null,
		mediaGameStart: 5,
		gameStartDraft: '5.0',
		selectedPlayerId: '',
		selectedSources: [],
		successMessage: null,
		errorMessage: null,
		players: [],
		playersLoading: false,
		playersError: null,
		mediaInfo: null,
		mediaLoading: false,
		mediaError: null,
		demoLoadGen: 0,
		mediaLoadGen: 0,
		injectorVisited: false
	});
}

export const [getInjectorForm, setInjectorForm] = createContext<InjectorForm>();
