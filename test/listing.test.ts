// The store listing against the manifest it describes.
//
// The listing is read by a human reviewer with the manifest open beside it, and
// a claim about permissions that the manifest contradicts is an "inaccurate
// representation" rejection — the single most avoidable one. It went stale
// exactly the way these things do: 1.12.0 added contextMenus and scripting,
// 1.13.0 added sidePanel, and the copy in all fifty-five locales went on saying
// "two Chrome permissions: storage and activeTab". Nothing checked, because
// nothing could: the listing is prose, in languages nobody on the project
// reads.
//
// The permission names are identifiers, untranslated in every locale, so they
// can be checked even where the sentence around them cannot.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, scenario } from './harness';

const ROOT = new URL('..', import.meta.url).pathname;
const TRANSLATIONS = join(ROOT, 'public', 'translations');

interface Manifest {
  version: string;
  permissions: string[];
  host_permissions?: string[];
}

export async function run(): Promise<void> {
  const manifest: Manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'manifest.json'), 'utf8'));
  const locales = readdirSync(TRANSLATIONS).filter(name => !name.startsWith('.'));

  const listingOf = (locale: string): string =>
    JSON.parse(readFileSync(join(TRANSLATIONS, locale, 'messages.json'), 'utf8')).storeDesc.message;

  scenario('The listing names every permission the manifest asks for');
  check('there are locales to check at all', locales.length > 0, String(locales.length));
  for (const permission of manifest.permissions) {
    const missing = locales.filter(locale => !listingOf(locale).includes(permission));
    check(
      `"${permission}" appears in every locale's description`,
      missing.length === 0,
      missing.join(', ')
    );
  }

  scenario('And claims nothing the manifest does not back up');
  // The English wording is the one that can be read here; the rest are pinned
  // by the identifier check above.
  const english = listingOf('en');
  check(
    'the old "two Chrome permissions" claim is gone',
    !/two Chrome permissions/i.test(english),
    english.slice(0, 0)
  );
  check(
    'no locale still says the manifest declares two',
    locales.every(locale => !/two Chrome permissions/i.test(listingOf(locale)))
  );

  // The manifest declares no content_scripts, and the listing may say so — but
  // quick fill injects a function through chrome.scripting, so "nothing ever
  // runs on a page you visit" is a stronger claim than the code supports.
  check(
    'the listing does not promise that nothing ever runs on a page',
    locales.every(locale => !/content scripts at all/i.test(listingOf(locale)))
  );

  // host_permissions is the one that changes the install dialog most, and the
  // listing says there are none.
  check(
    'the manifest really declares no host permissions',
    (manifest.host_permissions ?? []).length === 0,
    JSON.stringify(manifest.host_permissions)
  );

  // 1.14.0 brought a daily check-in with api.authenticator.sh (an anonymous
  // install id, the number of accounts, three settings, billing events) and a
  // free limit on new installations that Pro removes. The listing had said the
  // opposite in fifty-five languages: nothing is sent, there is no server, no
  // analytics, no paid tier. Each of those was true when it was written, and
  // each would now be an inaccurate representation. The English sentences are
  // pinned here by their exact words, so they cannot drift back in.
  scenario('The listing no longer promises what billing made untrue');
  for (const phrase of ['no paid tier', 'sends nothing about you', 'No analytics', 'no server to trust']) {
    check(`the English listing no longer says "${phrase}"`, !english.includes(phrase));
  }

  // The other languages cannot be read here, but the plan's name is not
  // translated in any of them, so a description without "Pro" is one where the
  // free-plan and network passages were never rewritten. It has to be the word,
  // not the letters: "Projekt", "Proč" and "Proširenje" were already in the old
  // German, Czech and Croatian text. Only Latin letters count as a neighbour,
  // because Arabic and Amharic attach their prepositions to it ("وPro", "የPro").
  const PRO = /(?<!\p{Script=Latin})Pro(?!\p{Script=Latin})/u;
  const withoutPro = locales.filter(locale => !PRO.test(listingOf(locale)));
  check('every locale\'s description names the Pro plan', withoutPro.length === 0, withoutPro.join(', '));

  // Chrome falls back to the default locale for a missing message without a
  // word, so a key added to English alone ships as English everywhere — which
  // is how the quick fill shortcut read in chrome://extensions/shortcuts in
  // all fifty-four other locales.
  scenario('Every message the manifest names exists in every locale');
  const manifestText = readFileSync(join(ROOT, 'public', 'manifest.json'), 'utf8');
  const named = [...new Set([...manifestText.matchAll(/__MSG_(\w+)__/g)].map(match => match[1]))];
  check('the manifest names some', named.length > 0, named.join(', '));
  for (const key of named) {
    const missing = locales.filter(locale => {
      const message = JSON.parse(readFileSync(join(TRANSLATIONS, locale, 'messages.json'), 'utf8'))[key]?.message;
      return typeof message !== 'string' || message.trim() === '';
    });
    check(`"${key}" is translated in every locale`, missing.length === 0, missing.join(', '));
  }

  scenario('The listing is not describing a different build');
  const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  check(
    'the manifest and package.json agree on the version',
    manifest.version === packageVersion,
    `${manifest.version} vs ${packageVersion}`
  );
}
