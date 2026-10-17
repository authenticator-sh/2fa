// The welcome page's "Open Authenticator" button.
//
// Half of new installs never open the extension at all (1.15.0, 10–17 Oct
// 2026: 51 % ever did, 42 % within two minutes of installing and almost nobody
// after): the icon is behind the puzzle piece, and a picture of where to find
// it was not enough. So the page that opens on install asks the extension to
// open itself, and the popup unfolds from the toolbar, where it lives.
//
// Two messages, from our own site only (manifest externally_connectable, and
// the origin checked again here): "ping", so the page shows the button only
// where there is an extension to answer it, and "open" — sent once by the page
// as it loads (`auto`; Chrome needs no click for openPopup, checked 2026-10-17)
// and again from the button, for whoever clicked the popup away. Nothing else
// a web page sends is listened to, and nothing about the accounts is sent back.

import { reportSiteOpen } from '@/billing/onboarding';
import { getOpenMode, type OpenMode } from '@/utils/open-mode';
import { clearSiteOpened, markSiteOpened } from '@/utils/site-opened';
import { openPopoutWindow } from '@/utils/popout';
import { openModeNow, openSidePanelInGesture } from './open-mode';

const SITE_ORIGINS: ReadonlySet<string> = new Set(['https://www.authenticator.sh', 'https://authenticator.sh']);

export interface SiteOpenReply {
  ok: boolean;
}

/** Opens whatever the icon would: the popup for nearly everyone, else the window or the panel. */
async function openFromSite(windowId: number | undefined, auto: boolean): Promise<SiteOpenReply> {
  // Started first, and awaited before the popup opens: the page that opens
  // reads it as it starts (utils/site-opened.ts).
  const marking = markSiteOpened();
  // Before the first await: the panel opens only inside the message's own run,
  // and only if the mode is already known (open-mode.ts says why). Chrome is
  // unlikely to count a page's message as that action, so a refusal opens the
  // floating window instead — it needs none.
  const panel = openSidePanelInGesture({ windowId });
  let mode: OpenMode | null = openModeNow();
  let ok = false;
  try {
    await marking;
    if (panel && (await panel)) {
      ok = true;
    } else {
      mode ??= await getOpenMode();
      if (mode === 'window' || mode === 'sidepanel') {
        await openPopoutWindow();
      } else {
        // Chrome 127+; older ones have no such function and land in the catch,
        // and the page keeps its picture of the puzzle piece.
        await chrome.action.openPopup(windowId !== undefined ? { windowId } : undefined);
      }
      ok = true;
    }
  } catch (error) {
    console.warn('could not open from the welcome page', error);
  }
  // Nothing opened to take it, and a click on the icon in the next seconds
  // must not be mistaken for the page's doing.
  if (!ok) await clearSiteOpened();
  void reportSiteOpen(ok, mode ?? 'unknown', auto);
  return { ok };
}

export function registerSiteOpen(): void {
  // Absent where a browser does not let pages talk to extensions; the page then
  // gets no answer to its ping and keeps its picture of the puzzle piece.
  chrome.runtime.onMessageExternal?.addListener((message: unknown, sender, sendResponse) => {
    if (!sender.origin || !SITE_ORIGINS.has(sender.origin)) return false;
    const type = message && typeof message === 'object' ? (message as { type?: unknown }).type : undefined;
    if (type === 'ping') {
      sendResponse({ ok: true } satisfies SiteOpenReply);
      return false;
    }
    if (type !== 'open') return false;
    const auto = (message as { auto?: unknown }).auto === true;
    void openFromSite(sender.tab?.windowId, auto).then(sendResponse);
    return true;
  });
}
