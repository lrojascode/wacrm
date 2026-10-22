import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInboxViewport } from './use-inbox-viewport';

function Inbox({ enabled = true }: { enabled?: boolean }) {
  const ref = useInboxViewport(enabled);
  return <div ref={ref} data-testid="inbox" />;
}

let viewport: EventTarget & {
  height: number;
  offsetTop: number;
  scale: number;
};
let mobile: EventTarget & { matches: boolean };
const height = () =>
  screen.getByTestId('inbox').style.getPropertyValue('--inbox-viewport-height');
const top = () =>
  screen.getByTestId('inbox').style.getPropertyValue('--inbox-viewport-top');
async function notify(target: EventTarget, event: string) {
  await act(async () => {
    target.dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(20);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  viewport = Object.assign(new EventTarget(), {
    height: 800,
    offsetTop: 0,
    scale: 1,
  });
  mobile = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('matchMedia', () => mobile);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) =>
    setTimeout(callback, 0)
  );
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('follows keyboard height and browser panning, then restores the available height', async () => {
  render(<Inbox />);
  expect(height()).toBe('800px');
  viewport.height = 380;
  viewport.offsetTop = 70;
  await notify(viewport, 'resize');
  expect(height()).toBe('380px');
  expect(top()).toBe('70px');
  viewport.offsetTop = 90;
  await notify(viewport, 'scroll');
  expect(top()).toBe('90px');
  viewport.height = 800;
  viewport.offsetTop = 0;
  await notify(viewport, 'resize');
  expect(height()).toBe('800px');
  expect(top()).toBe('0px');
});

it('does not resize the interface around pinch zoom', async () => {
  render(<Inbox />);
  viewport.scale = 2;
  viewport.height = 200;
  viewport.offsetTop = 120;
  await notify(viewport, 'resize');
  expect(height()).toBe('800px');
  expect(top()).toBe('0px');
  viewport.scale = 1;
  viewport.height = 800;
  viewport.offsetTop = 0;
  await notify(viewport, 'resize');
  expect(height()).toBe('800px');
});

it('clears mobile dimensions on desktop and removes listeners on navigation', async () => {
  const view = render(<Inbox />);
  mobile.matches = false;
  await notify(mobile, 'change');
  expect(height()).toBe('');
  expect(top()).toBe('');
  mobile.matches = true;
  await notify(mobile, 'change');
  expect(height()).toBe('800px');
  const remove = vi.spyOn(viewport, 'removeEventListener');
  // A pending frame must not apply stale dimensions after leaving the inbox.
  viewport.dispatchEvent(new Event('resize'));
  view.rerender(<Inbox enabled={false} />);
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(height()).toBe('');
  expect(top()).toBe('');
  expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
});

it('uses the window height when VisualViewport is unavailable', async () => {
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('innerHeight', 700);
  render(<Inbox />);
  expect(height()).toBe('700px');
  vi.stubGlobal('innerHeight', 360);
  await notify(window, 'resize');
  expect(height()).toBe('360px');
  expect(top()).toBe('0px');
});
