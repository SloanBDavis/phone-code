/**
 * What the page can ask the Mac app it runs in for (apple/PhoneCode/Mac/WebShell.swift).
 * The app adds a `phonecode` message handler only when it can show the pairing QR code,
 * so outside the Mac app (a phone, a browser) none of this shows.
 */
declare global {
  interface Window {
    webkit?: { messageHandlers?: { phonecode?: { postMessage: (message: unknown) => void } } };
  }
}

const handler = () => window.webkit?.messageHandlers?.phonecode;

/** Inside the Mac app, with phone-code running on this Mac: it can pair a phone. */
export const canPairPhone = (): boolean => handler() !== undefined;

/** The Mac app shows the QR code a phone scans (its own sheet, over the page). */
export function pairPhone(): void {
  handler()?.postMessage({ type: 'pairPhone' });
}
