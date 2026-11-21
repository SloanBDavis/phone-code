import type { JSX } from 'preact';
import { popToRoot } from '../lib/nav';
import { BackButton, TopBar } from '../ui/chrome';
import { Icon, Spinner } from '../ui/icons';

export function LoadingScreen(): JSX.Element {
  return (
    <div class="screen" data-testid="screen-loading">
      <TopBar left={<BackButton />} fade={false} />
      <div class="center-fill">
        <Spinner size={22} />
      </div>
    </div>
  );
}

export function MissingScreen(): JSX.Element {
  return (
    <div class="screen grouped" data-testid="screen-missing">
      <TopBar left={<BackButton />} fade={false} />
      <div class="center-fill">
        <div class="empty">
          <Icon name="info" size={40} stroke={1.6} />
          <h2>Session ended</h2>
          <p>This session is no longer on your computer.</p>
          <button type="button" class="btn btn-secondary" onClick={popToRoot}>
            Back to sessions
          </button>
        </div>
      </div>
    </div>
  );
}
