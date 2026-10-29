export const SHARE_LIFETIME_DAYS = 7;
export const SHARE_LIFETIME_MS = SHARE_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
export const SHARE_PART_SIZE = 16 * 1024 * 1024;
export const MAX_SHARE_SIZE = 200 * 1024 * 1024;
export const SHARE_SIZE_ERROR = 'Share links support demos up to 200 MB.';
/** Count Unicode code points, including supplementary characters, consistently. */
export const MAX_SHARE_NAME_LENGTH = 200;
export const SHARE_ID_PATTERN =
	/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** Cap for saved links that can no longer be revoked. Live deletion keys are not capped. */
export const MAX_SAVED_SHARES = 100;

export interface SavedShare {
	id: string;
	name: string;
	size: number;
	createdAt: string;
	expiresAt: string;
	/** Uploader-only capability. Never include this in the public page or copied URL. */
	deleteToken?: string;
}

export interface GeneratedDemo {
	id: string;
	name: string;
	blob: Blob;
	warning?: string;
}

export function shareIsExpired(share: SavedShare, now = Date.now()): boolean {
	return Date.parse(share.expiresAt) <= now;
}

export function shareExpiryLabel(expiresAt: string, now = Date.now()): string {
	const remaining = Date.parse(expiresAt) - now;
	if (!Number.isFinite(remaining) || remaining <= 0) return 'Expired';
	for (const [unit, duration] of [
		['day', 86_400_000],
		['hour', 3_600_000],
		['minute', 60_000]
	] as const) {
		if (remaining >= duration) {
			const count = Math.ceil(remaining / duration);
			return `Expires in ${count} ${unit}${count === 1 ? '' : 's'}`;
		}
	}
	return 'Expires in less than a minute';
}

export function shareDateDetails(share: SavedShare): string {
	return `Uploaded ${new Date(share.createdAt).toLocaleString()} · Expires ${new Date(share.expiresAt).toLocaleString()}`;
}

/**
 * Keep every unexpired share that still has a deletion key.
 * Newest disposable entries fill whatever room remains under the cap.
 */
export function retainSavedShares(
	shares: SavedShare[],
	now = Date.now(),
	limit = MAX_SAVED_SHARES
): SavedShare[] {
	const protectedCount = shares.filter(
		(share) => share.deleteToken && !shareIsExpired(share, now)
	).length;
	let disposable = 0;
	const slots = Math.max(0, limit - protectedCount);
	return shares.filter((share) => {
		if (share.deleteToken && !shareIsExpired(share, now)) return true;
		if (disposable >= slots) return false;
		disposable += 1;
		return true;
	});
}

/** Store IDs, never arbitrary URLs from browser storage. */
export function readSavedShares(raw: string | null): SavedShare[] {
	if (!raw) return [];
	const values: unknown = JSON.parse(raw);
	if (!Array.isArray(values)) return [];
	const ids = new Set<string>();
	return retainSavedShares(
		values
			.filter((value): value is SavedShare => {
				if (!value || typeof value !== 'object') return false;
				const share = value as Partial<SavedShare>;
				if (
					typeof share.id !== 'string' ||
					!SHARE_ID_PATTERN.test(share.id) ||
					ids.has(share.id) ||
					typeof share.name !== 'string' ||
					Array.from(share.name).length > MAX_SHARE_NAME_LENGTH ||
					!share.name.endsWith('.dem') ||
					typeof share.size !== 'number' ||
					!Number.isSafeInteger(share.size) ||
					share.size <= 0 ||
					// Keep older, larger links manageable after reducing the upload limit.
					share.size > 2 * 1024 * 1024 * 1024 ||
					typeof share.createdAt !== 'string' ||
					!Number.isFinite(Date.parse(share.createdAt)) ||
					typeof share.expiresAt !== 'string' ||
					!Number.isFinite(Date.parse(share.expiresAt)) ||
					Date.parse(share.expiresAt) <= Date.parse(share.createdAt)
				)
					return false;
				ids.add(share.id);
				return true;
			})
			.map((share) => ({
				id: share.id,
				name: share.name,
				size: share.size,
				createdAt: share.createdAt,
				expiresAt: new Date(
					Math.min(Date.parse(share.expiresAt), Date.parse(share.createdAt) + SHARE_LIFETIME_MS)
				).toISOString(),
				...(typeof share.deleteToken === 'string' && SHARE_ID_PATTERN.test(share.deleteToken)
					? { deleteToken: share.deleteToken }
					: {})
			}))
	);
}
