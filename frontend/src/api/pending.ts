import { protectedData } from '../auth/protected-data';
import { ApiError } from './client';

export type PendingAttempt = {id: string; path: string; method: string; body: unknown};

// Session storage keeps only the operation UUID. The exact request stays in memory, so an explicit
// identical retry survives closing its editor but not a reload or the end of the session.
export function holdAttempt(marker: string, attempt: PendingAttempt) {
  sessionStorage.setItem(marker, attempt.id); protectedData.set(marker, attempt);
}
export function heldAttempt(marker: string): PendingAttempt | null {
  const attempt = protectedData.get(marker) as PendingAttempt | undefined;
  return attempt && attempt.id === sessionStorage.getItem(marker) ? attempt : null;
}
export function releaseAttempt(marker: string) {
  sessionStorage.removeItem(marker); protectedData.delete(marker);
}
export function rejectedOutright(failure: unknown): failure is ApiError {
  return failure instanceof ApiError && !failure.uncertain && !['operation_in_progress', 'operation_payload_mismatch'].includes(failure.code);
}
