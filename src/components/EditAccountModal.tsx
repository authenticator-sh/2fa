import { useId, useState } from 'react';
import { Eye, EyeOff, Plus, X } from 'lucide-react';
import type { Account } from '@/types';
import { ModalHeader } from './ModalHeader';
import { GroupInput } from './GroupInput';
import { createT, type Language } from '@/utils/i18n';
import { checkReplacementSecret, needsNewSecret } from '@/utils/secret-edit';
import { MAX_SITES, normalizeSite, sitesOf } from '@/utils/account-sites';

interface EditAccountModalProps {
  account: Account;
  onClose: () => void;
  /** Resolves `false` when the account no longer exists; the parent says so. */
  onSave: (id: string, updates: Partial<Account>) => Promise<boolean | void>;
  language: Language;
  /** Existing group names, offered as suggestions — the field stays free text. */
  groups?: string[];
  /** The whole list, so a replacement key can be checked against the others. */
  accounts?: Pick<Account, 'id' | 'secret'>[];
  /** The page the popup was opened on, offered as a one-click site. */
  currentHost?: string | null;
}

export function EditAccountModal({ account, onClose, onSave, language, groups = [], accounts = [], currentHost = null }: EditAccountModalProps) {
  const t = createT(language);
  const ids = useId();
  const [name, setName] = useState(account.name);
  const [issuer, setIssuer] = useState(account.issuer);
  const [group, setGroup] = useState(account.group ?? '');
  const [sites, setSites] = useState<string[]>(() => sitesOf(account));
  const [siteDraft, setSiteDraft] = useState('');
  const [siteError, setSiteError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Decided once, from the account the screen was opened for: the field must
  // not lock itself mid-edit the moment the typed key becomes valid.
  const [secretEditable] = useState(() => needsNewSecret(account));
  // Starts from what is stored, not blank — the usual fault is one mistyped
  // character (a 0 for an O, an 8 for a B), and retyping the whole key to fix
  // it is how a second one gets in.
  const [secret, setSecret] = useState(() => String(account.secret ?? ''));
  const [secretError, setSecretError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // The add form has always required a name; this one did not, so the field
    // could be emptied and saved. Beyond leaving a row with nothing to identify
    // it, a nameless account used to make the whole backup file it ended up in
    // unimportable — the import rejected the file on the first entry missing a
    // name, taking every good account with it.
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('edit.nameRequired'));
      return;
    }

    const updates: Partial<Account> = {};

    // Checked only once it has been touched: a rename of a broken account is
    // still a rename, and refusing it until the key is fixed would hold the
    // name hostage to a key the user may not have to hand.
    if (secretEditable && secret !== String(account.secret ?? '')) {
      const checked = checkReplacementSecret(secret, account.id, accounts, account.type);
      if ('error' in checked) {
        setSecretError(t(checked.error));
        return;
      }
      if (checked.secret !== account.secret) updates.secret = checked.secret;
    }

    // Whatever is still in the box counts: typing a site and pressing Save
    // without Add is the obvious thing to do, and dropping it would be a
    // change that silently did not happen.
    let nextSites = sites;
    if (siteDraft.trim()) {
      const added = addSite(siteDraft);
      if (!added) return;
      nextSites = added;
    }
    if (nextSites.join(' ') !== sitesOf(account).join(' ')) {
      updates.sites = nextSites.length ? nextSites : undefined;
    }

    if (trimmedName !== account.name) updates.name = trimmedName;
    if (issuer !== account.issuer) updates.issuer = issuer;

    // Blank clears the group rather than storing an empty string, so an account
    // the user emptied out counts as ungrouped everywhere without a second case
    // to check. updateAccount drops the key on `undefined`.
    const nextGroup = group.trim();
    if (nextGroup !== (account.group?.trim() ?? '')) {
      updates.group = nextGroup || undefined;
    }

    if (Object.keys(updates).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      await onSave(account.id, updates);
      onClose();
    } catch {
      // The parent has already said so; staying open keeps what was typed.
    } finally {
      setSaving(false);
    }
  };

  /** The list with this site added, or null (and the error shown) when it is not one. */
  function addSite(input: string): string[] | null {
    const site = normalizeSite(input);
    if (!site) {
      setSiteError(t('edit.sitesInvalid'));
      return null;
    }
    const next = sites.includes(site) ? sites : [...sites, site].slice(0, MAX_SITES);
    setSites(next);
    setSiteDraft('');
    setSiteError(null);
    return next;
  }

  const currentSite = currentHost ? normalizeSite(currentHost) : null;
  const offerCurrent = currentSite !== null && !sites.includes(currentSite) && sites.length < MAX_SITES;

  // String(): this screen is exactly where a record with a malformed key lands,
  // and a key that is not a string at all must not crash the way out of it.
  const maskedSecret = String(account.secret ?? '').replace(/./g, '\u2022');

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-gray-50 dark:bg-dark-800 anim-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={t('edit.title')}
    >
      <ModalHeader title={t('edit.title')} back={t('common.back')} onBack={onClose} />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-md p-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor={`${ids}-name`} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t('addAccount.accountName')}
              </label>
              <input
                id={`${ids}-name`}
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${ids}-name-error` : undefined}
                className={`w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border focus:ring-2 focus:ring-accent-500/20 outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500 ${
                  error
                    ? 'border-red-400 dark:border-red-500 focus:border-red-500'
                    : 'border-gray-300 dark:border-dark-600 focus:border-accent-500'
                }`}
              />
              {error && (
                <p id={`${ids}-name-error`} className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>
              )}
            </div>

            <div>
              <label htmlFor={`${ids}-issuer`} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t('addAccount.issuer')}
              </label>
              <input
                id={`${ids}-issuer`}
                type="text"
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                className="w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-dark-600 focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500"
              />
            </div>

            <div>
              <label
                htmlFor="edit-account-secret"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
              >
                {t('addAccount.secretKey')}
              </label>
              {secretEditable ? (
                <>
                  <input
                    id="edit-account-secret"
                    type="text"
                    value={secret}
                    onChange={(e) => {
                      setSecret(e.target.value);
                      if (secretError) setSecretError(null);
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={secretError ? true : undefined}
                    className={`w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm font-mono rounded-lg px-3 py-2 border focus:ring-2 focus:ring-accent-500/20 outline-none transition-all ${
                      secretError
                        ? 'border-red-400 dark:border-red-500 focus:border-red-500'
                        : 'border-gray-300 dark:border-dark-600 focus:border-accent-500'
                    }`}
                  />
                  <p
                    className={`mt-1.5 text-xs ${
                      secretError ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'
                    }`}
                  >
                    {secretError ?? t('edit.secretHint')}
                  </p>
                </>
              ) : (
                <div className="relative">
                  <input
                    id="edit-account-secret"
                    type="text"
                    value={showSecret ? account.secret : maskedSecret}
                    readOnly
                    className="w-full bg-gray-50 dark:bg-dark-900/50 text-gray-900 dark:text-gray-100 text-sm font-mono rounded-lg px-3 py-2 pe-10 border border-gray-300 dark:border-dark-600 outline-none cursor-default"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    aria-label={t('a11y.showKey')}
                    aria-pressed={showSecret}
                    className="absolute end-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors p-1"
                  >
                    {showSecret ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                  </button>
                </div>
              )}
            </div>

            {/* Last, because it is the only optional field here — an empty box
                above the ones that must be filled reads as another required
                step. */}
            <GroupInput
              inputId="edit-account-group"
              value={group}
              onChange={setGroup}
              groups={groups}
              language={language}
            />

            <div>
              <label htmlFor={`${ids}-site`} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t('edit.sites')}
              </label>
              {sites.length > 0 && (
                <ul className="mb-2 flex flex-wrap gap-1.5">
                  {sites.map(site => (
                    <li
                      key={site}
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-gray-100 dark:bg-dark-700 ps-2.5 pe-1 py-0.5 text-xs text-gray-800 dark:text-gray-200"
                    >
                      <span className="truncate" dir="ltr">{site}</span>
                      <button
                        type="button"
                        onClick={() => setSites(sites.filter(entry => entry !== site))}
                        aria-label={t('edit.sitesRemove', site)}
                        className="rounded-full p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-dark-600 dark:hover:text-gray-200"
                      >
                        <X size={12} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {sites.length < MAX_SITES && (
                <div className="flex gap-2">
                  <input
                    id={`${ids}-site`}
                    type="text"
                    inputMode="url"
                    dir="ltr"
                    value={siteDraft}
                    placeholder="example.com"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    onChange={(e) => {
                      setSiteDraft(e.target.value);
                      if (siteError) setSiteError(null);
                    }}
                    onKeyDown={(e) => {
                      // Enter adds the site rather than saving the form with a
                      // half-typed list.
                      if (e.key === 'Enter' && siteDraft.trim()) {
                        e.preventDefault();
                        addSite(siteDraft);
                      }
                    }}
                    aria-invalid={siteError ? true : undefined}
                    aria-describedby={`${ids}-site-hint`}
                    className={`min-w-0 flex-1 bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border focus:ring-2 focus:ring-accent-500/20 outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500 ${
                      siteError
                        ? 'border-red-400 dark:border-red-500 focus:border-red-500'
                        : 'border-gray-300 dark:border-dark-600 focus:border-accent-500'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => addSite(siteDraft)}
                    disabled={!siteDraft.trim()}
                    className="shrink-0 rounded-lg border border-gray-300 dark:border-dark-600 px-3 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-dark-700 disabled:opacity-40"
                  >
                    {t('edit.sitesAdd')}
                  </button>
                </div>
              )}
              {offerCurrent && (
                <button
                  type="button"
                  onClick={() => addSite(currentSite)}
                  className="mt-2 inline-flex max-w-full items-center gap-1 text-xs font-medium text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300"
                >
                  <Plus size={12} aria-hidden className="shrink-0" />
                  <span className="truncate">{t('edit.sitesAddCurrent', currentSite)}</span>
                </button>
              )}
              <p
                id={`${ids}-site-hint`}
                className={`mt-1.5 text-xs ${siteError ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
              >
                {siteError ?? t('edit.sitesHint')}
              </p>
            </div>

            {/* One full-width button, as on the add screen. Cancel sat here
                back when this was a dialog with a cross in the corner; beside
                a header that is nothing but a back arrow it was a second name
                for the same door. */}
            <button
              type="submit"
              disabled={saving}
              className="w-full rounded-lg bg-accent-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-700 disabled:opacity-50"
            >
              {t('edit.save')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
