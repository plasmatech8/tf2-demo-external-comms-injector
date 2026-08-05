/** TF2 team color helpers (`red` / `blue` from demostf). */

export function teamDotStyle(team?: string): string | null {
	const t = (team ?? '').trim().toLowerCase();
	if (t === 'red') return 'background-color: var(--color-team-red)';
	if (t === 'blue' || t === 'blu') return 'background-color: var(--color-team-blue)';
	return null;
}
