/**
 * The exact phrase a user must type to confirm account deletion.
 * Lives outside actions.ts because a "use server" module may only
 * export async functions. Imported by both the confirmation UI (to
 * enable the button) and the Server Action (which re-checks it — the
 * UI check is a convenience, never the enforcement).
 */
export const DELETE_ACCOUNT_CONFIRMATION = "DELETE";
