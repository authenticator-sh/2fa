// Where a phone without the app gets it: the address the "Move to phone"
// screen shows as a QR code (TransferModal). Ours, redirecting to the App
// Store listing (site/src/app/iphone/route.ts), so the code in installed
// copies keeps working whatever the listing's address turns out to be.
//
// null in a build whose brand has no phone app (extension-lite): the screen
// then shows no download code.

//
// Until the iPhone app is in the App Store that address says it is coming
// (site/src/app/[lang]/iphone); afterwards it goes straight to the listing.
export const PHONE_APP_URL: string | null = 'https://www.authenticator.sh/iphone';

let hidden = false;

/** A host that is itself the phone app (mobile/) offers no phone app. */
export function hidePhoneApp(): void {
  hidden = true;
}

export function phoneAppUrl(): string | null {
  return hidden ? null : PHONE_APP_URL;
}
