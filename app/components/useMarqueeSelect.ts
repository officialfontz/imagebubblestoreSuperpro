"use client";

// ── Drag-to-select ────────────────────────────────────────────────────────────
// Press on empty canvas and drag a box; every tile it touches gets selected.
//
// The box is tracked in the scroller's CONTENT coordinates rather than viewport
// ones, so it stays anchored to the grid while the view auto-scrolls — drag past
// the bottom edge and the canvas follows, mounting more rows as it goes, exactly
// the way a file manager behaves.
//
// All the pointer bookkeeping lives inside one effect: the handlers run far more
// often than React should re-render, and the auto-scroll loop has to be able to
// re-schedule itself.

import { useEffect, useRef, useState } from "react";

/** Movement below this is a click, not a drag — so a stray press does not wipe
 *  the selection with a zero-size box. */
const DRAG_THRESHOLD_PX = 5;
/** How close to an edge the pointer must get before the view starts scrolling. */
const EDGE_PX = 64;
const MAX_SCROLL_STEP = 22;

export type MarqueeRect = { left: number; top: number; width: number; height: number };

export function useMarqueeSelect({
  scrollRef,
  enabled,
  onSelect,
  onClear,
}: {
  scrollRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  /** Ids the box currently covers. `additive` mirrors the modifier keys. */
  onSelect: (ids: string[], additive: boolean) => void;
  /** A press-and-release on empty space with no drag. */
  onClear: () => void;
}): MarqueeRect | null {
  const [rect, setRect] = useState<MarqueeRect | null>(null);

  // Latest callbacks, so the effect does not need to re-subscribe when the
  // parent re-renders mid-drag.
  const handlers = useRef({ onSelect, onClear });
  useEffect(() => { handlers.current = { onSelect, onClear }; }, [onSelect, onClear]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!enabled || !el) return;

    let drag: {
      startX: number; startY: number;
      pointerX: number; pointerY: number;
      additive: boolean;
      moved: boolean;
    } | null = null;
    let frame = 0;

    const contentPoint = (clientX: number, clientY: number) => {
      const box = el.getBoundingClientRect();
      return { x: clientX - box.left + el.scrollLeft, y: clientY - box.top + el.scrollTop };
    };

    const apply = () => {
      if (!drag) return;
      const here = contentPoint(drag.pointerX, drag.pointerY);
      const left = Math.min(drag.startX, here.x);
      const top = Math.min(drag.startY, here.y);
      const width = Math.abs(here.x - drag.startX);
      const height = Math.abs(here.y - drag.startY);

      if (!drag.moved && Math.max(width, height) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      setRect({ left, top, width, height });

      // Only mounted tiles can be hit-tested; the auto-scroll below is what
      // brings the rest into reach.
      const box = el.getBoundingClientRect();
      const hits: string[] = [];
      for (const node of el.querySelectorAll<HTMLElement>(".tile[data-id]")) {
        const r = node.getBoundingClientRect();
        const tileLeft = r.left - box.left + el.scrollLeft;
        const tileTop = r.top - box.top + el.scrollTop;
        const overlaps =
          tileLeft < left + width && tileLeft + r.width > left &&
          tileTop < top + height && tileTop + r.height > top;
        if (overlaps) hits.push(node.dataset.id!);
      }
      handlers.current.onSelect(hits, drag.additive);
    };

    const tick = () => {
      frame = 0;
      if (!drag) return;

      const box = el.getBoundingClientRect();
      const fromTop = drag.pointerY - box.top;
      const fromBottom = box.bottom - drag.pointerY;

      let delta = 0;
      if (fromTop < EDGE_PX) delta = -Math.ceil(((EDGE_PX - fromTop) / EDGE_PX) * MAX_SCROLL_STEP);
      else if (fromBottom < EDGE_PX) delta = Math.ceil(((EDGE_PX - fromBottom) / EDGE_PX) * MAX_SCROLL_STEP);

      if (delta !== 0) el.scrollTop += delta;
      apply();

      // Keep ticking while the pointer is parked in the hot zone — no further
      // mousemove events will arrive to drive it.
      if (delta !== 0) frame = requestAnimationFrame(tick);
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // Anything interactive keeps its own behaviour.
      if (target.closest(".tile, button, a, input, [role='button']")) return;

      const start = contentPoint(e.clientX, e.clientY);
      drag = {
        startX: start.x, startY: start.y,
        pointerX: e.clientX, pointerY: e.clientY,
        additive: e.shiftKey || e.metaKey || e.ctrlKey,
        moved: false,
      };
      // Stops the browser turning the drag into a text selection.
      e.preventDefault();
    };

    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      drag.pointerX = e.clientX;
      drag.pointerY = e.clientY;
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const onUp = () => {
      const finished = drag;
      drag = null;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      setRect(null);
      // A press with no drag on empty space means "deselect everything".
      if (finished && !finished.moved && !finished.additive) handlers.current.onClear();
    };

    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, scrollRef]);

  return rect;
}
