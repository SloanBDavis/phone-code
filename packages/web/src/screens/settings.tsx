import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import '../styles/settings.css';
import { setCursorConnected } from '../lib/actions';
import { CURSOR_APP } from '../lib/agents';
import { exitDemo, unpairDevice } from '../lib/boot';
import { connectionOf } from '../lib/connection';
import { harnessList } from '../lib/harness';
import { pushSupport, disablePush, enablePush } from '../lib/push';
import { canPairPhone, pairPhone } from '../lib/shell';
import { conn, host, isDemo } from '../lib/state';
import { creds, settings, updateSettings, type ThemePref } from '../lib/storage';
import { haptic, isStandalone } from '../lib/util';
import { APP_VERSION, SOURCE_URL } from '../lib/version';
import { GlassButton } from '../ui/glass';
import { Glyph, agentGlyph } from '../ui/glyph';
import { Icon, Spinner } from '../ui/icons';
import { alertDialog, toast } from '../ui/overlay';

const PLATFORM: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

function NotificationsRow(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const support = pushSupport();
  const on = settings.value.notifications && support === 'ok';
  const note = isDemo.value
    ? 'Not available in the demo.'
    : support === 'needs-install'
      ? 'On iPhone, notifications work in the Home Screen app. Add phone-code to your Home Screen, open it from there, then turn this on.'
      : support === 'needs-https'
        ? 'Notifications need an https address for this computer (for example Tailscale). This connection is plain http.'
        : support === 'unsupported'
          ? 'This browser does not support web notifications.'
          : support === 'denied'
            ? 'Notifications are blocked for this app. Allow them in Settings > Notifications.'
            : support === 'no-key'
              ? 'This host does not offer notifications yet. Update phone-code on your computer.'
              : 'Get a notification when an agent finishes or needs your approval.';
  return (
    <>
      <div class="list">
        <label class="cell">
          <span class="cell-icon">
            <Icon name="bell" size={18} stroke={2.1} />
          </span>
          <span class="cell-main cell-title">Notifications</span>
          {busy && <Spinner size={16} />}
          <input
            type="checkbox"
            class="switch"
            checked={on}
            disabled={support !== 'ok' || busy}
            data-testid="settings-notifications"
            onChange={(e) => {
              const want = e.currentTarget.checked;
              setBusy(true);
              (want ? enablePush() : disablePush())
                .then(() => toast(want ? 'Notifications on' : 'Notifications off', 'bell'))
                .catch((err: unknown) => {
                  toast(err instanceof Error ? err.message : 'Could not change notifications', 'warn');
                })
                .finally(() => setBusy(false));
            }}
          />
        </label>
      </div>
      <p class="footnote" data-testid="notifications-note">
        {note}
      </p>
    </>
  );
}

/**
 * Cursor's desktop app: follow its chats here (phone-code's hook in Cursor's
 * hooks.json) or stop. Shown when Cursor is on this computer.
 */
function CursorSection({ connected }: { connected: boolean }): JSX.Element {
  const [busy, setBusy] = useState(false);
  // What the switch shows while the host works on it; back to the host's answer after.
  const [want, setWant] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section class="section" data-testid="settings-cursor">
      <h2 class="section-head">Cursor</h2>
      <div class="list">
        <label class="cell">
          <Glyph kind={CURSOR_APP} size={30} />
          <span class="cell-main cell-title">Follow Cursor chats</span>
          {busy && <Spinner size={16} />}
          <input
            type="checkbox"
            class="switch"
            checked={want ?? connected}
            disabled={busy}
            data-testid="cursor-toggle"
            onChange={(e) => {
              const on = e.currentTarget.checked;
              haptic('light');
              setBusy(true);
              setWant(on);
              setError(null);
              setCursorConnected(on)
                .catch((err: unknown) => {
                  setError(
                    err instanceof Error
                      ? err.message
                      : on
                        ? 'Could not connect Cursor'
                        : 'Could not disconnect Cursor',
                  );
                })
                .finally(() => {
                  setBusy(false);
                  setWant(null);
                });
            }}
          />
        </label>
      </div>
      {error && (
        <p class="footnote error" role="alert" data-testid="cursor-error">
          {error}
        </p>
      )}
      <p class="footnote">
        Your Cursor app chats show up here as you work: what you asked, its thinking, commands, edits and
        answers. When Cursor finishes a turn, reply here and it continues that chat. phone-code adds a hook to
        Cursor (<code class="cmd">~/.cursor/hooks.json</code>) and keeps your other hooks.
      </p>
    </section>
  );
}

/** One line of "what works on this connection". */
function Works({ ok, label, testid }: { ok: boolean; label: string; testid: string }): JSX.Element {
  return (
    <div class="cell static works" data-testid={testid} data-ok={ok}>
      <span class={`works-mark ${ok ? 'ok' : 'no'}`}>
        <Icon name={ok ? 'check' : 'close'} size={14} stroke={3} />
      </span>
      <span class="cell-main cell-title">{label}</span>
    </div>
  );
}

/**
 * "This computer": how the phone reaches it and what that allows, what you
 * can run there, and the few preferences there are. Opened from the host name
 * at the top of the sidebar.
 */
export default function ComputerSheet({ close }: { close: () => void }): JSX.Element {
  const h = host.value;
  const c = creds.value;
  const s = settings.value;
  const demo = isDemo.value;
  const info = connectionOf(h);
  const online = conn.value.status === 'open';
  const secure = info.secure;
  const installed = isStandalone();

  return (
    <div class="computer" data-testid="screen-settings">
      <div class="sheet-head">
        <span class="glass-btn glass-circle ghost" />
        <h2>This computer</h2>
        <GlassButton icon="close" label="Close" onClick={close} testid="computer-close" />
      </div>
      <div class="sheet-scroll">
        <section class="section">
          <div class="list">
            <div class="cell static host-cell">
              <span class="host-icon">
                <Icon name="laptop" size={26} stroke={1.8} />
              </span>
              <span class="cell-main">
                <span class="cell-title host-name">{h?.name ?? c?.host.name ?? 'Not connected'}</span>
                <span class="cell-sub" data-testid="connection-mode" data-mode={info.mode}>
                  {demo ? 'Demo: a simulated computer' : online ? info.label : 'Not connected right now'}
                </span>
              </span>
            </div>
            {h && (
              <div class="cell static">
                <span class="cell-main cell-title">System</span>
                <span class="cell-value">
                  {PLATFORM[h.platform] ?? h.platform} · phone-code {h.daemonVersion}
                </span>
              </div>
            )}
            {canPairPhone() && (
              <button
                type="button"
                class="cell"
                onClick={() => {
                  close();
                  pairPhone();
                }}
                data-testid="settings-pair-phone"
              >
                <span class="cell-icon">
                  <Icon name="qr" size={17} stroke={2} />
                </span>
                <span class="cell-main">
                  <span class="cell-title">Pair a phone</span>
                  <span class="cell-sub">Show the QR code your iPhone scans</span>
                </span>
                <Icon name="forward" size={15} stroke={2.4} class="cell-chev" />
              </button>
            )}
          </div>
        </section>

        {!demo && (
          <section class="section" data-testid="connection-works">
            <h2 class="section-head">On this connection</h2>
            <div class="list">
              <Works ok label="Chats and terminals" testid="works-chat" />
              <Works ok={secure} label="Notifications" testid="works-notifications" />
              <Works ok={secure} label="Opens without a connection" testid="works-offline" />
              <Works ok={secure} label="In-app QR scanner" testid="works-scanner" />
            </div>
            {!secure && (
              <p class="footnote fix" data-testid="connection-fix">
                These need an https address for your computer. The simple way is Tailscale, free for personal
                use: on your computer run <code class="cmd">npx phone-code setup</code>. It checks Tailscale
                and tells you the one thing to do. Then pair this phone again from the new QR code.
              </p>
            )}
          </section>
        )}

        {h && (
          <section class="section">
            <h2 class="section-head">What you can use</h2>
            <div class="list">
              {harnessList().map((a) => (
                <div
                  class={`cell static ${a.available ? '' : 'off'}`}
                  key={a.id}
                  data-testid="settings-agent"
                  data-agent={a.id}
                >
                  <Glyph kind={a.id === 'terminal' ? 'terminal' : agentGlyph(a.id)} size={30} />
                  <span class="cell-main">
                    <span class="cell-title">
                      {a.id === 'terminal' ? 'Terminal' : (a.info?.name ?? a.id)}
                    </span>
                    {!a.available && (
                      <span class="cell-sub" data-testid="setup-hint">
                        {a.info?.setupHint ?? 'Not installed on this computer'}
                      </span>
                    )}
                  </span>
                  <span class={`cell-value ${a.available ? '' : 'warn'}`}>
                    {a.available
                      ? a.id === 'terminal'
                        ? (h.shell.split('/').pop() ?? 'shell')
                        : a.info?.version
                          ? `v${a.info.version}`
                          : 'Ready'
                      : 'Not set up'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {h?.cursor?.installed && <CursorSection connected={h.cursor.connected} />}

        <section class="section">
          <h2 class="section-head">Notifications</h2>
          <NotificationsRow />
        </section>

        <section class="section">
          <h2 class="section-head">Appearance</h2>
          <div class="list">
            <div class="cell static">
              <span class="cell-icon">
                <Icon name="moon" size={17} stroke={2.1} />
              </span>
              <span class="cell-main cell-title">Theme</span>
              <fieldset class="segmented theme-seg" aria-label="Theme">
                {(['system', 'dark', 'light'] as ThemePref[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={s.theme === t}
                    data-testid={`theme-${t}`}
                    onClick={() => {
                      haptic('light');
                      updateSettings({ theme: t });
                    }}
                  >
                    {t === 'system' ? 'Auto' : t === 'dark' ? 'Dark' : 'Light'}
                  </button>
                ))}
              </fieldset>
            </div>
            <div class="cell static">
              <span class="cell-icon">
                <Icon name="textSize" size={18} stroke={2} />
              </span>
              <span class="cell-main cell-title">Terminal text</span>
              <fieldset class="stepper" aria-label="Terminal font size">
                <button
                  type="button"
                  aria-label="Smaller"
                  disabled={s.termFontSize <= 9}
                  onClick={() => updateSettings({ termFontSize: s.termFontSize - 1 })}
                  data-testid="settings-font-smaller"
                >
                  <Icon name="minus" size={16} stroke={2.6} />
                </button>
                <span class="stepper-value" data-testid="settings-font-size">
                  {s.termFontSize}
                </span>
                <button
                  type="button"
                  aria-label="Larger"
                  disabled={s.termFontSize >= 22}
                  onClick={() => updateSettings({ termFontSize: s.termFontSize + 1 })}
                  data-testid="settings-font-larger"
                >
                  <Icon name="plus" size={16} stroke={2.6} />
                </button>
              </fieldset>
            </div>
          </div>
        </section>

        <section class="section">
          <h2 class="section-head">This phone</h2>
          <div class="list">
            <div class="cell static">
              <span class="cell-main cell-title">Paired</span>
              <span class="cell-value">
                {c ? new Date(c.pairedAt).toLocaleDateString() : demo ? 'Demo' : '—'}
                {installed ? ' · Home Screen app' : ''}
              </span>
            </div>
            {demo ? (
              <button
                type="button"
                class="cell destructive"
                onClick={() => {
                  close();
                  exitDemo();
                }}
                data-testid="settings-exit-demo"
              >
                <span class="cell-main cell-title">Exit demo</span>
              </button>
            ) : (
              <button
                type="button"
                class="cell destructive"
                data-testid="settings-unpair"
                onClick={() =>
                  void alertDialog({
                    title: 'Unpair this phone?',
                    message:
                      'You will need to scan a new QR code from your computer to connect again. A Home Screen app set up from this page is unpaired too.',
                    confirm: 'Unpair',
                    destructive: true,
                    testid: 'unpair-dialog',
                  }).then((ok) => {
                    if (ok) {
                      close();
                      unpairDevice();
                    }
                    return ok;
                  })
                }
              >
                <span class="cell-main cell-title">Unpair from {c?.host.name ?? 'host'}</span>
              </button>
            )}
          </div>
        </section>

        <div class="about">
          <img src="/icons/icon.svg" width={40} height={40} alt="" />
          <div class="about-name">phone-code {APP_VERSION}</div>
          <div class="about-sub">Free and open source under the MIT license.</div>
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" data-testid="settings-source">
            Source code
            <Icon name="forward" size={13} stroke={2.6} />
          </a>
        </div>
      </div>
    </div>
  );
}
