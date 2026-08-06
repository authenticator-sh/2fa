// Outward links that appear in more than one screen, kept in one place so a
// moved board or a renamed page is a single edit rather than a grep.

// Public feature board: requests, votes and what we are working on next.
// Deliberately not the support inbox — anything broken should reach us
// privately and immediately, ideas are better in the open where other people
// can add their vote.
export const FEATURE_REQUEST_URL = 'https://authenticator.featurebase.app';

/**
 * The help page, in the reader's own language.
 *
 * The answers used to ship inside the extension — thirteen entries in twenty
 * languages, around 8 KB of prose per language, carried by every popup open to
 * serve a panel most people never touch. On the site they are fetched once by
 * whoever actually has a question, and they can be found by search besides.
 *
 * `anchor` is an id from the page's question list. Two of them are load-bearing:
 * `time-sync` is where the clock warning sends people, and `password-protection`
 * is linked from the vault settings. Both are also anchors in a version of the
 * extension already installed on machines we cannot update, so the page must
 * keep answering to them.
 */
export function helpUrl(language: string, anchor?: string): string {
  // www, not the apex: the apex 307-redirects here, and the site declares
  // itself at this host in every canonical and hreflang. Sending people through
  // a redirect also drops the fragment in some clients, which would land
  // someone who clicked "how do I fix this?" at the top of the page instead of
  // on the answer.
  return `https://www.authenticator.sh/${language}/faq${anchor ? `#${anchor}` : ''}`;
}
