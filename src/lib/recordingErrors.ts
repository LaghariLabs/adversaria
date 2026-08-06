/** Errors from the recording pipeline that a retry can never clear.
 *
 *  The transcription queue used to append "the recording is safe on this device —
 *  open it and press Transcribe now to retry" to EVERY failure. That is true when
 *  the local AI service is merely down, and a lie when the spool's index is gone:
 *  the encrypted audio cannot be read without it, so the button can never succeed.
 *  A user pressing a doomed button and being told their recording is safe is worse
 *  than being told plainly that it is not.
 *
 *  Mirrors `recording_spool::UNRECOVERABLE_PREFIX`. Kept as one phrase so the two
 *  sides cannot drift.
 */
export const UNRECOVERABLE_PREFIX = "This recording can't be recovered";

/** Whether this failure is permanent, so the caller must not offer a retry. */
export function isUnrecoverable(error: unknown): boolean {
  return String(error).includes(UNRECOVERABLE_PREFIX);
}
