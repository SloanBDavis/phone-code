/**
 * Smoke subset in real WebKit (Safari's engine), run by the "webkit" project
 * only. The daemon serves plain http on the machine's LAN address, so the page
 * is a non-secure context like an iPhone on Wi-Fi without https: no service
 * worker, push or camera. Covers the bugs first seen on a real iPhone: a lazily
 * loaded sheet staying empty, the model menu floating away from its chip, a
 * gesture stuck half way, and the http-only wording.
 */
import { expect, test, type Phone } from '../lib/fixtures.ts';
import {
  closeComputer,
  newChat,
  openChat,
  openComputer,
  openSidebar,
  openTerminal,
  send,
  startChat,
  waitTurn,
} from '../lib/ui.ts';

test.use({ daemonOptions: { insecure: true } });

test('pairs over plain http and says what needs https', async ({ newPhone, daemon }) => {
  expect(daemon.url).toMatch(/^http:\/\/(?!127\.|localhost)/);
  const phone = await newPhone();
  const { pairUrl } = await daemon.newPairCode();
  await phone.page.goto(pairUrl);
  await expect(phone.testId('pair-install')).toBeVisible();
  expect(await phone.page.evaluate(() => window.isSecureContext)).toBe(false);
  await expect(phone.testId('pair-insecure')).toContainText('https');
  await expect(phone.testId('pair-install')).not.toContainText('notifications and');
  await phone.testId('pair-continue').click();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open');

  await openComputer(phone);
  await expect(phone.testId('notifications-note')).toContainText('https');
  await expect(phone.testId('notifications-note')).not.toContainText('browser');
  await expect(phone.testId('works-notifications')).toHaveAttribute('data-ok', 'false');
  await closeComputer(phone);
});

test('lazily loaded sheets always fill in; every harness starts a chat', async ({ phone, daemon }) => {
  // The folder sheet's content is a lazily loaded chunk that usually lands between render and effect.
  for (let i = 0; i < 3; i++) {
    await phone.testId('composer-folder').click();
    const sheet = phone.testId('folder-sheet');
    await expect(sheet.getByTestId('folder-choose')).toBeVisible();
    await sheet.getByTestId('folder-close').click();
    await expect(sheet).toBeHidden();
  }
  for (const kind of ['claude', 'codex']) {
    await startChat(phone, kind, 'hello', { folder: daemon.folder(`wk-${kind}`) });
    await waitTurn(phone, 1);
  }
  await openTerminal(phone, { folder: daemon.folder('wk-terminal') });
});

test('chat: send, allow a permission, models by name, Auto mode', async ({ phone }) => {
  await newChat(phone, 'claude');
  const perm = phone.testId('chat-item-permission');
  await send(phone, 'run tests please');
  await expect(perm.last()).toHaveAttribute('data-status', 'pending');
  await perm.last().getByTestId('permission-allow').click();
  await waitTurn(phone, 1);
  await expect(perm.last()).toHaveAttribute('data-status', 'allowed');

  // The chip names the model in use (what "default" stands for), not "Model".
  const chip = phone.testId('composer-model');
  await expect(chip).toHaveText('Sonnet Fake');
  await chip.click();
  const menu = phone.testId('model-menu');
  await expect(menu.getByRole('menuitem')).toHaveText([
    /Default \(recommended\)/,
    /Opus Fake/,
    /Sonnet Fake/,
    /Haiku Fake/,
  ]);
  await expect(menu.getByTestId('model-default').locator('.menu-check svg')).toBeVisible();
  await expectAnchored(phone, chip, menu);
  // The keyboard closing right after the tap grows the app: the menu follows the chip.
  const size = phone.page.viewportSize() ?? { width: 393, height: 659 };
  await phone.page.setViewportSize({ width: size.width, height: size.height - 260 });
  await expectAnchored(phone, chip, menu);
  await phone.page.setViewportSize(size);
  await expectAnchored(phone, chip, menu);
  await menu.getByTestId('model-opus').click();
  await expect(chip).toHaveText('Opus Fake');

  await phone.testId('composer-mode').click();
  await phone.testId('mode-menu').getByTestId('mode-auto').click();
  await expect(phone.testId('composer-mode')).toHaveText(/Auto/);
  // Auto: the routine command runs without asking.
  await send(phone, 'run tests again');
  await waitTurn(phone, 2);
  await expect(perm).toHaveCount(1);
});

test('Codex does not offer Auto', async ({ phone }) => {
  await newChat(phone, 'codex');
  await phone.testId('composer-mode').click();
  await expect(phone.testId('mode-menu').getByTestId('mode-default')).toBeVisible();
  await expect(phone.testId('mode-menu').getByTestId('mode-auto')).toHaveCount(0);
  await phone.page.keyboard.press('Escape');
});

test('terminal typing', async ({ phone }) => {
  await openTerminal(phone);
  const rows = phone.testId('terminal').locator('.xterm-rows');
  await expect(rows).toContainText('$');
  await phone.testId('terminal').click();
  await phone.page.keyboard.type('echo "wk=$((6*7))"');
  await phone.page.keyboard.press('Enter');
  await expect(rows).toContainText('wk=42');
});

test('launch reopens the chat that was open', async ({ phone }) => {
  const id = await startChat(phone, 'claude', 'hello');
  await waitTurn(phone, 1);
  await phone.page.goto('/');
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', id);
  await phone.testId('new-chat').click();
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-draft', 'true');
  await phone.page.reload();
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-draft', 'true');
  await openChat(phone, id);
});

type Step = [type: string, x: number];

interface TouchFactories {
  createTouch(v: Window, t: EventTarget, id: number, px: number, py: number, sx: number, sy: number): Touch;
  createTouchList(...t: Touch[]): TouchList;
}

/**
 * Synthesized drawer drags as iOS can deliver them: pointer and touch events,
 * ending in pointerup, touchend, touchcancel only, or nothing at all.
 * ['wait', ms] pauses. Opening starts on the left-edge strip, closing on the
 * dimmed chat.
 */
async function edgeSwipe(phone: Phone, steps: Step[]): Promise<void> {
  await gesture(phone, '[data-testid="edge-swipe"]', steps);
}

async function scrimSwipe(phone: Phone, steps: Step[]): Promise<void> {
  await gesture(phone, '[data-testid="drawer-scrim"]', steps);
}

/** Like edgeSwipe on any element; `y` steps move vertically instead (['y:pointermove', 300]). */
async function gesture(
  phone: Phone,
  selector: string,
  steps: Step[],
  at?: { x: number; y: number },
): Promise<void> {
  await phone.page.evaluate(
    async ({ list, sel, start }) => {
      const strip = document.querySelector(sel);
      if (!strip) throw new Error(`no ${sel}`);
      let y = start?.y ?? 400;
      let x = start?.x ?? 0;
      // Defined in here: this function runs in the page. Uses `strip` so it stays per call.
      const hasFactories = (d: unknown): d is TouchFactories =>
        strip.isConnected &&
        typeof d === 'object' &&
        d !== null &&
        'createTouch' in d &&
        'createTouchList' in d;
      const make = (type: string): Event => {
        if (type.startsWith('pointer'))
          return new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            clientX: x,
            clientY: y,
          });
        // WebKit has no Touch constructor; the legacy factories work.
        const doc: unknown = document;
        if (!hasFactories(doc)) throw new Error('no document.createTouch');
        const t = doc.createTouch(window, strip, 7, x, y, x, y);
        const ending = type === 'touchend' || type === 'touchcancel';
        const touches = ending ? doc.createTouchList() : doc.createTouchList(t);
        // WebKit's TouchEventInit takes TouchLists, not the arrays the DOM types declare.
        const init = {
          bubbles: true,
          cancelable: true,
          touches,
          targetTouches: touches,
          changedTouches: doc.createTouchList(t),
        };
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- WebKit-specific init shape
        return new TouchEvent(type, init as unknown as TouchEventInit);
      };
      for (const [step, v] of list) {
        if (step === 'wait') {
          await new Promise((r) => setTimeout(r, v));
          continue;
        }
        const vertical = step.startsWith('y:');
        const type = vertical ? step.slice(2) : step;
        if (vertical) y = v;
        else x = v;
        strip.dispatchEvent(make(type));
        await new Promise((r) => setTimeout(r, 16));
      }
    },
    { list: steps, sel: selector, start: at },
  );
}

/** The drawer fully open or fully closed: state, position and no drag in progress. */
async function settled(phone: Phone, want: 'open' | 'closed'): Promise<void> {
  await expect(phone.testId('shell')).toHaveAttribute('data-drawer', want);
  await expect(phone.page.locator('.shell.dragging')).toHaveCount(0);
  await expect
    .poll(() =>
      phone.page.evaluate(() => {
        const side = document.querySelector<HTMLElement>('.sidebar');
        if (!side) return 'none';
        if (side.style.transform !== '' || side.style.transition !== '') return 'inline styles left';
        return side.getBoundingClientRect().right > 40 ? 'open' : 'closed';
      }),
    )
    .toBe(want);
  // Usable: the sidebar takes taps when open.
  if (want === 'open') await expect(phone.testId('sidebar-new-chat')).toBeVisible();
}

test('the drawer always settles, however the touch ends', async ({ phone }) => {
  const W = phone.page.viewportSize()?.width ?? 393;
  await settled(phone, 'closed');

  // A system gesture takes the touch past half way: touchcancel only, no pointer end. Opens.
  await edgeSwipe(phone, [
    ['pointerdown', 4],
    ['touchstart', 4],
    ['pointermove', 80],
    ['touchmove', 80],
    ['pointermove', W * 0.7],
    ['touchmove', W * 0.7],
    ['wait', 200],
    ['touchcancel', W * 0.7],
  ]);
  await settled(phone, 'open');

  // Closing from the dimmed chat, touch events only, released far left: closes.
  await scrimSwipe(phone, [
    ['touchstart', W - 20],
    ['touchmove', W - 80],
    ['touchmove', 40],
    ['wait', 200],
    ['touchend', 40],
  ]);
  await settled(phone, 'closed');

  // A short, slow drag that is cancelled: stays closed.
  await edgeSwipe(phone, [
    ['pointerdown', 4],
    ['pointermove', 30],
    ['pointermove', 60],
    ['wait', 200],
    ['pointercancel', 60],
  ]);
  await settled(phone, 'closed');

  // No end event at all: the watchdog settles it (closed: short and at rest).
  await edgeSwipe(phone, [
    ['pointerdown', 4],
    ['pointermove', 40],
    ['pointermove', 90],
  ]);
  await settled(phone, 'closed');

  // A fling opens even when short.
  await edgeSwipe(phone, [
    ['pointerdown', 4],
    ['pointermove', 30],
    ['pointermove', 90],
    ['pointerup', 90],
  ]);
  await settled(phone, 'open');

  // A tap on the dimmed chat closes; the button opens again; Escape closes.
  await scrimSwipe(phone, [
    ['pointerdown', W - 20],
    ['pointerup', W - 20],
  ]);
  await settled(phone, 'closed');
  await phone.testId('open-sidebar').click();
  await settled(phone, 'open');
  await phone.page.keyboard.press('Escape');
  await settled(phone, 'closed');

  // A vertical drag on the edge is not a drawer gesture.
  await edgeSwipe(phone, [
    ['pointerdown', 4],
    ['y:pointermove', 480],
    ['y:pointermove', 600],
    ['pointerup', 4],
  ]);
  await settled(phone, 'closed');
});

test('sheet drag and row swipe settle when the touch is cancelled', async ({ phone }) => {
  // Sheet: a short drag cancelled by the system snaps back, a long one dismisses.
  await phone.testId('composer-folder').click();
  const sheet = phone.testId('folder-sheet');
  await expect(sheet.getByTestId('folder-choose')).toBeVisible();
  const grab = '[data-testid="folder-sheet"] .sheet-grabber';
  const top = (await sheet.boundingBox())?.y ?? 100;
  const steps = (dy: number): Step[] => [
    ['y:pointerdown', top + 4],
    ['y:pointermove', top + 20],
    ['y:pointermove', top + dy],
    ['wait', 200],
    ['y:touchcancel', top + dy],
  ];
  await gesture(phone, grab, steps(50), { x: 200, y: top + 4 });
  await expect.poll(() => sheet.evaluate((el) => el.style.transform)).toBe('');
  await expect(sheet.getByTestId('folder-choose')).toBeVisible();
  await gesture(phone, grab, steps(260), { x: 200, y: top + 4 });
  await expect(sheet).toBeHidden();

  // Row: a swipe left cancelled past half way settles open, with its actions usable.
  const id = await openTerminal(phone);
  await openSidebar(phone);
  const content = `.swipe:has([data-session-id="${id}"]) .swipe-content`;
  const box = await phone.page.locator(content).boundingBox();
  if (!box) throw new Error('row not visible');
  const x0 = box.x + box.width - 30;
  await gesture(
    phone,
    content,
    [
      ['pointerdown', x0],
      ['pointermove', x0 - 20],
      ['pointermove', x0 - 70],
      ['pointermove', x0 - 120],
      ['touchcancel', x0 - 120],
    ],
    { x: x0, y: box.y + box.height / 2 },
  );
  const swipe = phone.page.locator('.swipe', { has: phone.page.locator(`[data-session-id="${id}"]`) });
  await expect(swipe).toHaveAttribute('data-open', 'true');
  await expect(swipe.getByTestId('session-archive')).toBeVisible();
});

/** The menu sits right above (or below) its chip, horizontally overlapping it. */
async function expectAnchored(
  phone: Phone,
  chip: ReturnType<Phone['testId']>,
  menu: ReturnType<Phone['testId']>,
): Promise<void> {
  await expect
    .poll(async () => {
      const c = await chip.boundingBox();
      const m = await menu.boundingBox();
      if (!c || !m) return 'missing';
      const gap = Math.min(Math.abs(c.y - (m.y + m.height)), Math.abs(m.y - (c.y + c.height)));
      const overlapX = Math.min(c.x + c.width, m.x + m.width) - Math.max(c.x, m.x);
      return gap <= 12 && overlapX > 0
        ? 'anchored'
        : `gap ${Math.round(gap)} overlap ${Math.round(overlapX)}`;
    })
    .toBe('anchored');
}
