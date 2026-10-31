import { useCallback, useEffect, useRef, useState } from 'react';
import { isNearBottom } from './scroll';

interface Options {
  /** Changing this resets to "following" — e.g. when the user opens another session. */
  resetKey?: string | null;
  /** Called whenever the container updates, so the caller can add its own deps. */
  signature: string;
}

export interface StickToBottom {
  ref: React.RefObject<HTMLDivElement | null>;
  /** True while the user is scrolling away from the bottom (fades out after a pause). */
  showJump: boolean;
  jumpToBottom(): void;
  onScroll(): void;
}

/** The affordance is a hint, not a permanent toolbar: hide it once scrolling stops. */
const JUMP_HIDE_MS = 3000;

/**
 * Keeps the transcript pinned to the bottom while a run streams — unless the
 * user has scrolled up, in which case we stop chasing and surface a jump
 * affordance instead.
 *
 * `signature` is a cheap string standing in for "something rendered changed"
 * (message count + the last message's text length); a full deep-compare on
 * every token would defeat the point.
 */
export function useStickToBottom({ resetKey, signature }: Options): StickToBottom {
  const ref = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const hideTimer = useRef<number | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  const scrollToBottom = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  // Opening a different session starts fresh at the bottom.
  useEffect(() => {
    following.current = true;
    setShowJump(false);
    clearHideTimer();
    scrollToBottom();
  }, [resetKey, scrollToBottom, clearHideTimer]);

  useEffect(() => {
    if (!following.current) return;
    scrollToBottom();
  }, [signature, scrollToBottom]);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const near = isNearBottom(element);
    following.current = near;
    clearHideTimer();
    if (near) {
      setShowJump(false);
      return;
    }
    setShowJump(true);
    // Momentum scrolling emits events continuously, so every event restarts the
    // countdown; only a real pause hides the button.
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setShowJump(false);
    }, JUMP_HIDE_MS);
  }, [clearHideTimer]);

  const jumpToBottom = useCallback(() => {
    following.current = true;
    clearHideTimer();
    setShowJump(false);
    scrollToBottom();
  }, [scrollToBottom, clearHideTimer]);

  return { ref, showJump, jumpToBottom, onScroll };
}
