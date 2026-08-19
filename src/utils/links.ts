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
  // www, not the apex, and no /en for English: the apex redirects to www and
  // /en/faq redirects to /faq, and the site declares itself at the redirect
  // destination in every canonical and hreflang. Sending people through a
  // redirect also drops the fragment in some clients, which would land someone
  // who clicked "how do I fix this?" at the top of the page instead of on the
  // answer — and every anchor this function takes is exactly that case.
  const path = language === 'en' ? '/faq' : `/${language}/faq`;
  return `https://www.authenticator.sh${path}${anchor ? `#${anchor}` : ''}`;
}

/**
 * The page explaining what changed in a release, in the reader's own language.
 *
 * The "What's new" modal has room for one line per change; the question people
 * actually have about inserting a code into a page — "wait, what can this thing
 * see?" — needs more than a line and a picture to answer. That answer lives on
 * the site, where it can also be found by someone who is not mid-update.
 *
 * `version` is in the path on purpose, and it is this build's own version. The
 * site rewrites its newest page every release, and this link ships inside an
 * installed extension that we cannot update — so without the version, everyone
 * who pressed "learn more" after the *next* release would have been reading
 * about a release they had not installed. A version the site has not published
 * yet (updated extension, not-yet-deployed site) is redirected there to the
 * newest page rather than 404ing.
 *
 * Same www-and-no-/en rule as helpUrl above, and for the same reason.
 */
export function whatsNewUrl(language: string, version?: string): string {
  const base = language === 'en' ? '/whats-new' : `/${language}/whats-new`;
  const path = version ? `${base}/${version}` : base;
  return `https://www.authenticator.sh${path}`;
}
