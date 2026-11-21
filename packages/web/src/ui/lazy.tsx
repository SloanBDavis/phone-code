import type { ComponentType, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** Code-split component without pulling in preact/compat. */
export function lazy<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  Fallback: ComponentType<P> | null = null,
): ComponentType<P> & { preload: () => Promise<unknown> } {
  let Loaded: ComponentType<P> | null = null;
  let pending: Promise<unknown> | null = null;
  const preload = (): Promise<unknown> => {
    pending ??= (async () => {
      Loaded = (await load()).default;
    })();
    return pending;
  };
  function Lazy(props: P): JSX.Element | null {
    const [, setReady] = useState(Loaded !== null);
    useEffect(() => {
      if (Loaded) return undefined;
      let alive = true;
      const wait = async (): Promise<void> => {
        await preload();
        if (alive) setReady(true);
      };
      wait().catch(() => undefined);
      return () => {
        alive = false;
      };
    }, []);
    if (Loaded) return <Loaded {...props} />;
    return Fallback ? <Fallback {...props} /> : null;
  }
  return Object.assign(Lazy, { preload });
}
