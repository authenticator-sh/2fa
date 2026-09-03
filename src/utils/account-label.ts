/**
 * How an account is named to the user, in one place.
 *
 * "Issuer: name" is right when the two say different things — "GitHub:
 * ada@work.com". It is wrong when they say the same thing, which is common:
 * an account added by hand with one word in both fields renders as "vpn: vpn",
 * and the delete confirmation asked "Delete lenagjeka: lenagjeka?".
 *
 * Typed defensively for the same reason `group` is: these fields arrive from
 * imported files as well as from our own form, and a number here used to reach
 * `.trim()` and take the popup down with it.
 */
export function accountLabel(account: { issuer?: unknown; name?: unknown }): string {
  const issuer = typeof account.issuer === 'string' ? account.issuer.trim() : '';
  const name = typeof account.name === 'string' ? account.name.trim() : '';
  if (!issuer) return name;
  if (!name) return issuer;
  // Case-insensitive: "Vpn" and "vpn" are the same word to a reader.
  if (issuer.toLowerCase() === name.toLowerCase()) return issuer;
  return `${issuer}: ${name}`;
}
