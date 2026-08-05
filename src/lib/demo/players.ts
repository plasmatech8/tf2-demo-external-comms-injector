/** Client-side TF2 demo player listing via @demostf/demo.js (minimal parse mode). */

export type DemoPlayer = {
	/** Demo user id (match state key). */
	userId: number;
	name: string;
	steamId: string;
	team?: string;
};

/** Matches @demostf/demo.js ParseMode.MINIMAL — skips entity packets for speed. */
const PARSE_MINIMAL = 0;

type DemoJsModule = {
	Demo: new (buffer: ArrayBuffer) => {
		getAnalyser: (mode?: number) => {
			getBody: () => {
				getState: () => {
					users: Record<
						string,
						{ name?: string; steamId?: string; userId?: number; team?: string }
					>;
				};
			};
		};
	};
};

export async function listDemoPlayers(file: File): Promise<DemoPlayer[]> {
	const mod = (await import('@demostf/demo.js')) as DemoJsModule;
	const buffer = await file.arrayBuffer();
	const demo = new mod.Demo(buffer);
	const state = demo.getAnalyser(PARSE_MINIMAL).getBody().getState();
	const users = state.users ?? {};

	const players: DemoPlayer[] = [];
	for (const entry of Object.values(users)) {
		const name = (entry.name ?? '').trim();
		const steamId = (entry.steamId ?? '').trim();
		const userId = Number(entry.userId);
		if (!name || !Number.isFinite(userId)) continue;
		if (!steamId || steamId.toUpperCase() === 'BOT') continue;
		if (name === 'SourceTV') continue;

		players.push({
			userId,
			name,
			steamId,
			team: entry.team
		});
	}

	players.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
	return players;
}
