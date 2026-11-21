import type { ButtonHTMLAttributes, ComponentChildren, HTMLAttributes, JSX, Ref } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { attachRefraction } from '../lib/glass';
import { haptic } from '../lib/util';
import { Icon, type IconName } from './icons';

/**
 * Liquid Glass primitives. All glass in the app comes from these, so the
 * material is tuned in one place (styles/glass.css):
 *
 *   GlassSurface  any floating container (bars, composer, key bar, cards)
 *   GlassButton   capsule or circular control that morphs on press
 *
 * Sheets and menus (ui/overlay.tsx) use the same material classes.
 */

function useRefraction(ref: { current: HTMLElement | null }, enabled = true): void {
  useEffect(() => {
    const el = ref.current;
    return el && enabled ? attachRefraction(el) : undefined;
  }, [ref, enabled]);
}

type Variant = 'regular' | 'clear' | 'tinted';

export function GlassSurface({
  children,
  class: cls = '',
  variant = 'regular',
  refract = true,
  elRef,
  ...rest
}: {
  children?: ComponentChildren;
  class?: string;
  variant?: Variant;
  refract?: boolean;
  elRef?: Ref<HTMLDivElement>;
} & Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'ref'>): JSX.Element {
  const local = useRef<HTMLDivElement>(null);
  useRefraction(local, refract);
  return (
    <div
      {...rest}
      ref={(el) => {
        local.current = el;
        if (typeof elRef === 'function') elRef(el);
        else if (elRef) elRef.current = el;
      }}
      class={`glass glass-${variant} ${cls}`}
    >
      {children}
    </div>
  );
}

export function GlassButton({
  icon,
  label,
  children,
  onClick,
  variant = 'regular',
  class: cls = '',
  title,
  disabled,
  testid,
  iconSize = 20,
  ...rest
}: {
  icon?: IconName;
  /** Accessible name when the button shows only an icon. */
  label?: string;
  children?: ComponentChildren;
  onClick?: (e: MouseEvent) => void;
  variant?: Variant;
  class?: string;
  title?: string;
  disabled?: boolean;
  testid?: string;
  iconSize?: number;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'class' | 'icon' | 'label'>): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  useRefraction(ref);
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      class={`glass glass-${variant} glass-btn ${children ? 'glass-capsule' : 'glass-circle'} ${cls}`}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      data-testid={testid}
      onClick={(e) => {
        haptic('light');
        onClick?.(e);
      }}
    >
      {icon && <Icon name={icon} size={iconSize} />}
      {children}
    </button>
  );
}
