// Reading a list of otpauth:// URIs — what people arrive with when they leave
// another authenticator.
//
// Pasting even ONE link was impossible before this: the only inputs were a QR
// image, the camera, a tab screenshot, and a form asking for the secret by
// hand. Someone holding a text URI had to pick `secret`, `issuer` and `digits`
// out of it themselves. Batch was the request; no text input at all was the
// hole underneath it.

import { generateRandomColor, parseQRCode, UnsupportedOTPTypeError, type ParsedOTPAuth } from './qr-parser';
import { cleanSecret } from './totp';
import { addMultipleAccounts, VaultLockedError } from './storage';
import { describeImport } from './import-message';
import { createT, type Language } from './i18n';
import type { Account } from '@/types';

/**
 * A ceiling, not a guess.
 *
 * The popup parses on its own thread and a megabyte of pasted text hangs it.
 * Cut lines are reported rather than dropped quietly — an import that silently
 * stops at 500 of 800 accounts is the failure this whole feature exists to
 * prevent.
 */
export const MAX_IMPORT_LINES = 500;

export interface URIImportPlan {
  accounts: ParsedOTPAuth[];
  /**
   * 1-based line numbers, each appearing once — never their content. Every one
   * of these lines holds a `?secret=`, and the parser's own rule is that the
   * URL is never logged.
   */
  unreadable: number[];
  /** Lines that parsed and were understood to be counter-based. */
  hotp: number[];
  /** Entries a migration payload on some line refused on its own. */
  skippedInBatch: number;
  /** Links past MAX_IMPORT_LINES, never looked at. */
  ignored: number;
}

/**
 * Is this a URI list rather than one of the JSON formats?
 *
 * Deliberately narrow: it answers on the first non-blank line, so a JSON file
 * can never be mistaken for one of these, and a URI list can never be handed to
 * JSON.parse and reported as "invalid backup file".
 */
export function looksLikeURIList(text: string): boolean {
  const first = text.split(/\r?\n/).find(line => line.trim().length > 0);
  return first !== undefined && /^otpauth(-migration)?:\/\//i.test(first.trim());
}

export function planURIImport(text: string): URIImportPlan {
  const entries: { line: number; value: string }[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    // A paste can arrive with its newlines collapsed to spaces — a single-line
    // input does that on the way in. Every URI is still there, so one line may
    // legitimately hold several.
    for (const part of line.split(/\s+(?=otpauth)/i)) {
      const value = part.trim();
      if (value) entries.push({ line: index + 1, value });
    }
  });

  const considered = entries.slice(0, MAX_IMPORT_LINES);
  // Counted in links, not lines, because the cap applies to links and one line
  // can hold several. Counting the *lines* not otherwise reached looked tidier
  // and was wrong in both directions: a paste whose newlines had collapsed to
  // spaces put every link on line 1, so every dropped link's line was already
  // reached and the count came out zero — six hundred links pasted, five
  // hundred imported, "Successfully imported 500 account(s)" and not a word
  // about the hundred that were thrown away. Silently importing a prefix is
  // the exact failure this cap exists to prevent.
  const ignored = entries.length - considered.length;

  const unreadable = new Set<number>();
  const hotp = new Set<number>();
  const plan: URIImportPlan = {
    accounts: [],
    unreadable: [],
    hotp: [],
    skippedInBatch: 0,
    ignored,
  };

  for (const entry of considered) {
    try {
      const parsed = parseQRCode(entry.value);
      if (!parsed || parsed.accounts.length === 0) {
        unreadable.add(entry.line);
        continue;
      }
      plan.accounts.push(...parsed.accounts);
      plan.skippedInBatch += parsed.skipped ?? 0;
    } catch (error) {
      // Understood and refused is not the same as unreadable: telling someone
      // their counter-based token is a corrupt line sends them back to export
      // it again, and the second export will not work either.
      if (error instanceof UnsupportedOTPTypeError) {
        hotp.add(entry.line);
      } else {
        unreadable.add(entry.line);
      }
    }
  }

  // Sorted so the numbers read in the order the user's eye scans the paste.
  plan.unreadable = [...unreadable].sort((a, b) => a - b);
  plan.hotp = [...hotp].sort((a, b) => a - b);
  return plan;
}

/** What the caller shows: a toast of this kind carrying this message. */
export interface URIImportOutcome {
  kind: 'success' | 'info' | 'error';
  message: string;
  /** Absent when nothing was written — nothing to refresh. */
  added?: number;
}

/**
 * The whole "a list of links arrived" path: plan it, write it, and say what
 * happened, in one place.
 *
 * It lives here rather than in the component that owns the paste dialog because
 * there are two ways a list of links reaches the app — pasted, and as a .txt
 * through either of the two file inputs — and the first version of this only
 * taught one of them. A file the extension itself had just written came back as
 * "invalid backup file" on the path the onboarding sends people down.
 */
export async function importURIList(text: string, language: Language): Promise<URIImportOutcome> {
  const t = createT(language);
  const plan = planURIImport(text);

  const accounts: Account[] = plan.accounts.map((parsed, index) => ({
    id: Date.now().toString() + index + Math.random().toString(36).substring(7),
    name: parsed.name,
    issuer: parsed.issuer,
    secret: cleanSecret(parsed.secret),
    algorithm: parsed.algorithm,
    digits: parsed.digits,
    period: parsed.period,
    createdAt: Date.now() + index,
    color: generateRandomColor(),
  }));

  // At most ten numbers: past that the list stops being something a person can
  // act on and starts being a wall.
  const listLines = (lines: number[]) =>
    lines.slice(0, 10).join(', ') + (lines.length > 10 ? '…' : '');

  const notes: string[] = [];
  if (plan.unreadable.length > 0) {
    notes.push(t('import.uriUnreadable', plan.unreadable.length, listLines(plan.unreadable)));
  }
  if (plan.hotp.length > 0) {
    notes.push(t('import.uriHotp', plan.hotp.length, listLines(plan.hotp)));
  }
  if (plan.skippedInBatch > 0) {
    notes.push(t('import.uriBatchSkipped', plan.skippedInBatch));
  }
  if (plan.ignored > 0) {
    notes.push(t('import.uriCapped', MAX_IMPORT_LINES, MAX_IMPORT_LINES + plan.ignored));
  }

  if (accounts.length === 0) {
    return { kind: 'error', message: [t('import.uriNothing'), ...notes].join(' ') };
  }

  try {
    const result = await addMultipleAccounts(accounts);
    return {
      kind: result.added > 0 && notes.length === 0 ? 'success' : 'info',
      message: [describeImport(result, language), ...notes].join(' '),
      added: result.added,
    };
  } catch (error) {
    if (error instanceof VaultLockedError) {
      return { kind: 'error', message: t('scan.lockedTitle') };
    }
    console.error('Failed to add accounts from a list of links:', error);
    return { kind: 'error', message: t('import.failed') };
  }
}
