/**
 * Host half of `dsh-notify`.
 *
 * Every notification is rendered by the browser half (`./client`) through the
 * Web Notification API, so there is nothing to provide on the Host plane. This
 * entry exists because a profile row mounts a package, and the client half only
 * reaches the browser once that row is part of the composed configuration.
 */

/** Plugin name, as the profile row spells it. */
export const name = 'dsh-notify'

/** No host-side contribution. */
export function apply(): void {}
