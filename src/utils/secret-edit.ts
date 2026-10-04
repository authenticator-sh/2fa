// Replacing the key of an account whose stored key cannot produce codes.
//
// The row for such an account says "Invalid key — edit or remove", and the edit
// screen used to show the key read-only and save only the name, issuer and
// group. The one fix the row asked for could not be made: the user's only way
// out was to delete the account and add it again, losing its name, group and
// place in the list.

import type { Account } from '@/types';
import type { TranslationKey } from './i18n';
import { steamSecretToBase32 } from './import-formats';
import { cleanSecret, isUsableSecret, validateSecret } from './totp';

/**
 * Whether the edit screen should offer the key for editing.
 *
 * Only for a key that is already unusable. A working key stays read-only: a
 * stray keystroke there would silently turn every code for that account wrong,
 * and nobody finds out until the next sign-in fails.
 */
export function needsNewSecret(account: Pick<Account, 'secret'>): boolean {
  return !isUsableSecret(account.secret);
}

/** The same folding storage deduplicates by, so "the same key" means the same thing here. */
function secretIdentity(secret: unknown): string {
  return cleanSecret(String(secret ?? '')).replace(/=+$/, '');
}

export type SecretCheck = { secret: string } | { error: TranslationKey };

/**
 * Validate a replacement key the way the manual add form validates a new one.
 *
 * The duplicate check matters more here than on the add form: storage folds
 * accounts that share a key into one on read, so saving a key another account
 * already holds would make one of the two rows vanish from the list.
 */
export function checkReplacementSecret(
  input: string,
  accountId: string,
  accounts: Pick<Account, 'id' | 'secret'>[],
  type?: Account['type']
): SecretCheck {
  // A Steam key is read the way the add form reads it, Base64 included; a
  // maFile's `shared_secret` checked as Base32 alone passed for one key in
  // fourteen and was stored unconverted.
  const secret = type === 'steam' ? steamSecretToBase32(input) || cleanSecret(input) : cleanSecret(input);
  if (!secret || !validateSecret(secret) || !isUsableSecret(secret)) {
    return { error: 'addAccount.errorInvalidSecret' };
  }

  const identity = secretIdentity(secret);
  const taken = accounts.some(
    account => account.id !== accountId && secretIdentity(account.secret) === identity
  );
  if (taken) return { error: 'edit.secretDuplicate' };

  return { secret };
}
