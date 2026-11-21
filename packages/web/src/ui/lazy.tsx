import type { ComponentType, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Spinner } from './icons';

function Waiting(): JSX.Element {
  return (
    <div class="lazy-state" data-testid="lazy-loading">
      <Spinner size={22} />
    </div>
  );
}

/**
 * Code-split component without pulling in preact/compat.
 *
 * The chunk can finish loading at any moment relative to render and effects
 * (it is usually preloaded on tap, so on a fast phone it lands between the
 * first render and the effect). The component therefore never trusts what it
 * saw at render time: the effect always re-renders once the chunk is there,
 * and a failed load shows a retry instead of an empty view.
 */
export function lazy<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  Fallback: ComponentType<P> = Waiting,
): ComponentType<P> & { preload: () => Promise<unknown> } {
  let Loaded: ComponentType<P> | null = null;
  let pending: Promise<unknown> | null = null;
  const preload = (): Promise<unknown> => {
    pending ??= (async () => {
      Loaded = (await load()).default;
    })().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  function Lazy(props: P): JSX.Element | null {
    const [state, setState] = useState<'wait' | 'ready' | 'failed'>(Loaded ? 'ready' : 'wait');
    useEffect(() => {
      if (state !== 'wait') return undefined;
      let alive = true;
      // Settles immediately when the chunk already arrived after the render above.
      preload().then(
        () => alive && setState('ready'),
        () => alive && setState('failed'),
      );
      return () => {
        alive = false;
      };
    }, [state]);
    if (Loaded) return <Loaded {...props} />;
    if (state === 'failed')
      return (
        <div class="lazy-state" data-testid="lazy-failed">
          <p>This part of the app did not load. Check the connection to your computer.</p>
          <button type="button" class="btn btn-secondary" onClick={() => setState('wait')}>
            Try again
          </button>
        </div>
      );
    return <Fallback {...props} />;
  }
  return Object.assign(Lazy, { preload });
}
