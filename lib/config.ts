// The single, canonical session that everyone opens by default.
//
// There are no private/random sessions in normal use: the public display page
// ("/") and the host dashboard ("/dashboard") both bind to this fixed id. The
// session is created on demand the first time it's touched (see ensureSession
// in sessionStore) so it always exists.
export const CANONICAL_ID = "HAVEN";

export const APP_NAME = "Lighthaven Singalong";
