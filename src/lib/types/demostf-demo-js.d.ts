declare module '@demostf/demo.js' {
	export class Demo {
		constructor(buffer: ArrayBuffer);
		static fromNodeBuffer(nodeBuffer: ArrayBuffer | Uint8Array): Demo;
		getAnalyser(mode?: number): {
			getHeader: () => Record<string, unknown>;
			getBody: () => {
				getState: () => {
					users: Record<
						string,
						{ name?: string; steamId?: string; userId?: number; team?: string }
					>;
				};
			};
		};
	}
}
