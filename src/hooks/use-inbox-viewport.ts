'use client';

import { useEffect, useRef } from 'react';

/** Keep the mobile inbox inside the area actually visible above the keyboard. */
export function useInboxViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;

    const mobile = window.matchMedia('(max-width: 1023px)');
    const viewport = window.visualViewport;
    let frame = 0;
    const reset = () => {
      element.style.removeProperty('--inbox-viewport-height');
      element.style.removeProperty('--inbox-viewport-top');
    };
    const update = () => {
      if (!mobile.matches) {
        reset();
        return;
      }
      // Pinch zoom also shrinks the visual viewport. Leave zoom to the
      // browser instead of resizing the entire interface around it.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const height = viewport?.height ?? window.innerHeight;
      const top = Math.max(0, viewport?.offsetTop ?? 0);
      if (height <= 0) return;
      for (const [name, value] of [
        ['--inbox-viewport-height', `${height}px`],
        ['--inbox-viewport-top', `${top}px`],
      ]) {
        if (element.style.getPropertyValue(name) !== value)
          element.style.setProperty(name, value);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    mobile.addEventListener('change', schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('pageshow', schedule);
      mobile.removeEventListener('change', schedule);
      reset();
    };
  }, [enabled]);

  return ref;
}
