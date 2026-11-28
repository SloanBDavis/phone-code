import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import '../styles/pair.css';
import { ApiError, parsePairing } from '../lib/api';
import { autoCode, handoffCode, mode, pairReason, redeem, startDemo } from '../lib/boot';
import { creds, markSeen } from '../lib/storage';
import { haptic, isIOS } from '../lib/util';
import { Icon, Spinner } from '../ui/icons';
import { lazy } from '../ui/lazy';
import { openSheet } from '../ui/overlay';

const Scanner = lazy(() => import('./scanner'));

function AppMark({ size = 88 }: { size?: number }): JSX.Element {
  return <img class="app-mark" src="/icons/icon.svg" width={size} height={size} alt="" aria-hidden="true" />;
}

async function handleInput(input: string, setError: (e: string | null) => void): Promise<boolean> {
  const p = parsePairing(input);
  if (!p) {
    setError('That does not look like a phone-code link or pairing code.');
    return false;
  }
  if (p.origin && p.origin !== location.origin) {
    // The QR points at the daemon's own address; pairing happens there.
    location.href = input.trim();
    return true;
  }
  try {
    await redeem(p.code);
    haptic('success');
    return true;
  } catch (e) {
    haptic('warning');
    setError(e instanceof ApiError ? e.message : 'Pairing failed. Try again.');
    return false;
  }
}

function AutoPair({ code }: { code: string }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void handleInput(code, setError);
  }, [code]);

  if (!error)
    return (
      <div class="pair-center" data-testid="pair-auto">
        <AppMark />
        <h1 class="pair-title">Pairing…</h1>
        <p class="pair-text">Connecting this phone to your computer.</p>
        <Spinner size={22} />
      </div>
    );
  return (
    <div class="pair-center" data-testid="pair-error">
      <span class="pair-error-icon">
        <Icon name="warn" size={30} stroke={2} />
      </span>
      <h1 class="pair-title">Couldn't pair</h1>
      <p class="pair-text">{error}</p>
      <p class="pair-text small">
        Run <code class="cmd">npx phone-code</code> on your computer again and scan the new QR code.
      </p>
      <button
        type="button"
        class="btn btn-primary btn-block"
        onClick={() => {
          autoCode.value = null;
          history.replaceState(null, '', '/#/');
        }}
        data-testid="pair-error-continue"
      >
        Continue
      </button>
    </div>
  );
}

function ManualPair(): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (input: string): Promise<void> => {
    setBusy(true);
    setError(null);
    await handleInput(input, setError);
    setBusy(false);
  };

  // The camera (getUserMedia) only exists on https.
  const secure = window.isSecureContext;
  const scan = (): void => {
    void Scanner.preload();
    openSheet(
      (close) => (
        <Scanner
          onResult={(text) => {
            close();
            void submit(text);
          }}
          close={close}
        />
      ),
      { large: true, testid: 'scanner-sheet', label: 'Scan QR code' },
    );
  };

  return (
    <div class="pair-scroll" data-testid="pair-manual">
      <div class="pair-hero">
        <AppMark size={96} />
        <h1 class="pair-title">phone-code</h1>
        <p class="pair-text">Your terminal, Claude Code and Codex, on your phone.</p>
      </div>
      {pairReason.value && (
        <div class="pair-reason" data-testid="pair-reason">
          <Icon name="info" size={18} />
          {pairReason.value}
        </div>
      )}
      <ol class="pair-steps">
        <li>
          <span class="step-n">1</span>
          <span>
            On your computer, run
            <code class="cmd block">npx phone-code</code>
          </span>
        </li>
        <li>
          <span class="step-n">2</span>
          <span>Scan the QR code it shows with your iPhone camera, or with the scanner below.</span>
        </li>
      </ol>
      <div class="pair-actions">
        {secure ? (
          <button type="button" class="btn btn-primary btn-block" onClick={scan} data-testid="pair-scan">
            <Icon name="qr" size={20} stroke={2} />
            Scan QR code
          </button>
        ) : (
          <p class="pair-text small center" data-testid="pair-scan-unavailable">
            The in-app scanner needs an https connection. Scan the QR code with the Camera app, or paste the
            link below.
          </p>
        )}
        <form
          class="pair-paste"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(value);
          }}
        >
          <input
            class="pair-input"
            value={value}
            placeholder="Paste a pairing link or code"
            aria-label="Pairing link or code"
            autocapitalize="off"
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setValue(e.currentTarget.value)}
            data-testid="pair-input"
          />
          <button
            type="submit"
            class="pair-go"
            disabled={!value.trim() || busy}
            aria-label="Pair"
            data-testid="pair-submit"
          >
            {busy ? <Spinner size={16} /> : <Icon name="forward" size={18} stroke={2.6} />}
          </button>
        </form>
        {error && (
          <p class="pair-err" role="alert" data-testid="pair-input-error">
            {error}
          </p>
        )}
      </div>
      <div class="pair-demo">
        <button type="button" class="btn btn-plain" onClick={() => void startDemo()} data-testid="pair-demo">
          <Icon name="laptop" size={18} />
          Try the demo
        </button>
        <p>Explore with a simulated computer. Nothing is installed.</p>
      </div>
      <p class="pair-foot">Free and open source · MIT</p>
    </div>
  );
}

/** "Add to Home Screen" coach, shown in iOS Safari right after pairing. */
export function InstallCoach(): JSX.Element {
  // The handoff code in the manifest is kept fresh by boot.ts while this page is visible.
  // Service workers, push and the camera only exist in a secure context (https).
  const secure = window.isSecureContext;
  const name = creds.value?.host.name ?? 'your computer';
  // What plain http leaves out is said here, once; the first chat does not repeat it.
  useEffect(() => {
    if (!secure) markSeen('http');
  }, [secure]);
  return (
    <div class="pair-scroll" data-testid="pair-install">
      <div class="pair-hero">
        <span class="pair-ok">
          <Icon name="check" size={34} stroke={3} />
        </span>
        <h1 class="pair-title">Paired with {name}</h1>
        <p class="pair-text">
          {secure
            ? 'Add phone-code to your Home Screen for full screen, notifications and instant launch.'
            : 'Add phone-code to your Home Screen for full screen and instant launch.'}
        </p>
      </div>
      {!secure && (
        <div class="pair-reason" data-testid="pair-insecure">
          <Icon name="info" size={18} />
          <span>
            This connection is plain http, so notifications, opening without a connection and the in-app QR
            scanner are not available. They need an https address for your computer, for example with
            Tailscale.
          </span>
        </div>
      )}
      <ol class="coach">
        <li>
          <span class="coach-icon">
            <Icon name="share" size={22} stroke={2} />
          </span>
          <span>
            Tap <strong>Share</strong> in Safari's toolbar
          </span>
        </li>
        <li>
          <span class="coach-icon">
            <Icon name="addSquare" size={22} stroke={2} />
          </span>
          <span>
            Choose <strong>Add to Home Screen</strong>
          </span>
        </li>
        <li>
          <span class="coach-icon is-app">
            <img src="/icons/icon.svg" alt="" width={30} height={30} />
          </span>
          <span>Open phone-code from your Home Screen. It signs itself in.</span>
        </li>
      </ol>
      {!handoffCode.value && isIOS() && (
        <p class="pair-text small center">If the installed app asks to pair, just scan the QR code again.</p>
      )}
      <div class="pair-actions">
        <button
          type="button"
          class="btn btn-secondary btn-block"
          onClick={() => {
            mode.value = 'app';
          }}
          data-testid="pair-continue"
        >
          Continue in Safari
        </button>
      </div>
    </div>
  );
}

export function PairScreen(): JSX.Element {
  const code = autoCode.value;
  return (
    <div class="screen grouped pair-screen" data-testid="screen-pair">
      {mode.value === 'install' ? <InstallCoach /> : code ? <AutoPair code={code} /> : <ManualPair />}
    </div>
  );
}
