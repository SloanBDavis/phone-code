import type { JSX } from 'preact';
import { TopBar } from '../ui/chrome';
import { Spinner } from '../ui/icons';
import { usePaneButtons } from '../ui/drawer';

export function LoadingScreen(): JSX.Element {
  const { left, right } = usePaneButtons();
  return (
    <div class="screen" data-testid="screen-loading">
      <TopBar left={left} right={right} fade={false} />
      <div class="center-fill">
        <Spinner size={22} />
      </div>
    </div>
  );
}
