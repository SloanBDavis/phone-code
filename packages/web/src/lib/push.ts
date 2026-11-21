import { client } from './client';
import { vapidKey } from './state';
import { updateSettings } from './storage';
import { isIOS, isStandalone } from './util';

export type PushSupport = 'ok' | 'needs-install' | 'unsupported' | 'no-key' | 'denied';

export function pushSupport(): PushSupport {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (!vapidKey.value) return 'no-key';
  return 'ok';
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function enablePush(): Promise<void> {
  const key = vapidKey.value;
  if (!key) throw new Error('This host does not offer notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed.');
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  await client.rpc({ t: 'push.subscribe', subscription: sub.toJSON() });
  updateSettings({ notifications: true });
}

export async function disablePush(): Promise<void> {
  updateSettings({ notifications: false });
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await client.rpc({ t: 'push.unsubscribe', endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}
