import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import '../styles/settings.css';
import { exitDemo, unpair } from '../lib/boot';
import { pushSupport, disablePush, enablePush } from '../lib/push';
import { deviceId, host, isDemo } from '../lib/state';
import { creds, settings, updateSettings, type ThemePref } from '../lib/storage';
import { haptic, isStandalone } from '../lib/util';
import { APP_VERSION, SOURCE_URL } from '../lib/version';
import { BackButton, TopBar, useScrolled } from '../ui/chrome';
import { Glyph } from '../ui/glyph';
import { Icon, Spinner } from '../ui/icons';
import { alertDialog, toast } from '../ui/overlay';
import { ConnectionLabel } from './sessions';

const PLATFORM: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div class="cell static">
      <span class="cell-main cell-title">{label}</span>
      <span class={`cell-value ${mono ? 'mono' : ''}`}>{value ?? '—'}</span>
    </div>
  );
}

function NotificationsRow(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const support = pushSupport();
  const on = settings.value.notifications && support === 'ok';
  const note =
    support === 'needs-install'
      ? 'On iPhone, notifications work in the Home Screen app. Add phone-code to your Home Screen, open it from there, then turn this on.'
      : support === 'unsupported'
        ? 'This browser does not support web notifications.'
        : support === 'denied'
          ? 'Notifications are blocked for this app. Allow them in Settings > Notifications.'
          : support === 'no-key'
            ? isDemo.value
              ? 'Not available in the demo.'
              : 'This host does not offer notifications yet. Update phone-code on your computer.'
            : 'Get a notification when an agent finishes or needs your approval.';
  return (
    <>
      <div class="list">
        <label class="cell">
          <span class="cell-icon" style={{ background: '#ff5a4f' }}>
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
      <p class="footnote">{note}</p>
    </>
  );
}

export function SettingsScreen(): JSX.Element {
  const [ref, scrolled] = useScrolled<HTMLDivElement>(30);
  const h = host.value;
  const c = creds.value;
  const s = settings.value;
  const demo = isDemo.value;

  return (
    <div class="screen grouped" data-testid="screen-settings">
      <div class="scroll" ref={ref}>
        <h1 class="large-title">Settings</h1>

        <section class="section">
          <div class="list">
            <div class="cell static host-cell">
              <span class="host-icon">
                <Icon name="laptop" size={26} stroke={1.8} />
              </span>
              <span class="cell-main">
                <span class="cell-title host-name">{h?.name ?? c?.host.name ?? 'Not connected'}</span>
                <span class="cell-sub">
                  <ConnectionLabel />
                </span>
              </span>
            </div>
            <Row label="System" value={h ? `${PLATFORM[h.platform] ?? h.platform} · ${h.user}` : undefined} />
            <Row label="Shell" value={h?.shell} mono />
            <Row label="phone-code on host" value={h?.daemonVersion} />
          </div>
        </section>

        {h && (
          <section class="section">
            <h2 class="section-head">Agents</h2>
            <div class="list">
              {h.agents.map((a) => (
                <div class="cell static" key={a.kind}>
                  <Glyph kind={a.kind} size={30} />
                  <span class="cell-main cell-title">{a.kind === 'claude' ? 'Claude Code' : 'Codex'}</span>
                  <span class={`cell-value ${a.available ? '' : 'warn'}`}>
                    {a.available ? (a.version ? `v${a.version}` : 'Installed') : 'Not installed'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section class="section">
          <h2 class="section-head">Notifications</h2>
          <NotificationsRow />
        </section>

        <section class="section">
          <h2 class="section-head">Appearance</h2>
          <div class="list">
            <div class="cell static">
              <span class="cell-icon" style={{ background: '#5e5ce6' }}>
                <Icon name="moon" size={17} stroke={2.1} />
              </span>
              <span class="cell-main cell-title">Theme</span>
              <div class="segmented theme-seg" role="group" aria-label="Theme">
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
              </div>
            </div>
            <div class="cell static">
              <span class="cell-icon" style={{ background: '#30b0c7' }}>
                <Icon name="textSize" size={18} stroke={2} />
              </span>
              <span class="cell-main cell-title">Terminal text</span>
              <div class="stepper" role="group" aria-label="Terminal font size">
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
              </div>
            </div>
          </div>
        </section>

        <section class="section">
          <h2 class="section-head">This device</h2>
          <div class="list">
            <Row label="Device ID" value={(deviceId.value ?? c?.deviceId)?.slice(0, 12)} mono />
            <Row label="Paired" value={c ? new Date(c.pairedAt).toLocaleDateString() : demo ? 'Demo' : undefined} />
            <Row label="Installed app" value={isStandalone() ? 'Yes' : 'No, running in the browser'} />
          </div>
        </section>

        <section class="section">
          <div class="list">
            {demo ? (
              <button type="button" class="cell destructive" onClick={exitDemo} data-testid="settings-exit-demo">
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
                    message: 'You will need to scan a new QR code from your computer to connect again.',
                    confirm: 'Unpair',
                    destructive: true,
                    testid: 'unpair-dialog',
                  }).then((ok) => ok && unpair())
                }
              >
                <span class="cell-main cell-title">Unpair from {c?.host.name ?? 'host'}</span>
              </button>
            )}
          </div>
        </section>

        <div class="about">
          <img src="/icons/icon.svg" width={44} height={44} alt="" />
          <div class="about-name">phone-code {APP_VERSION}</div>
          <div class="about-sub">Free and open source under the MIT license.</div>
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" data-testid="settings-source">
            Source code
            <Icon name="forward" size={13} stroke={2.6} />
          </a>
        </div>
      </div>
      <TopBar left={<BackButton label="Sessions" />} title="Settings" showTitle={scrolled} fade={scrolled} />
    </div>
  );
}
