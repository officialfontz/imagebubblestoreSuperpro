"use client";

// ── Grid virtualisation ───────────────────────────────────────────────────────
// With several hundred images, rendering every tile puts thousands of DOM nodes
// on the page and makes scrolling and selection sluggish, even though the <img>
// elements themselves are lazy. This keeps only the rows near the viewport
// mounted and pads the grid with empty space so the scrollbar stays honest.
//
// Geometry is MEASURED from the live grid rather than re-derived from the CSS.
// The layout is `repeat(auto-fill, minmax(var(--tile), 1fr))`, so the column
// count depends on the container width, the gap, and the density toggle —
// duplicating that arithmetic in JS would be one more thing to keep in sync and
// would silently drift the moment the stylesheet changed. Reading the resolved
// `grid-template-columns` gives the browser's own answer.

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** Below this many items, mounting everything is cheaper than the bookkeeping. */
export const VIRTUALIZE_THRESHOLD = 60;

/** Extra rows rendered above and below the viewport, so a fast flick does not
 *  outrun the scroll handler and expose blank space. */
const OVERSCAN_ROWS = 3;

type Geometry = { columns: number; rowHeight: number };

export type VirtualWindow = {
  /** First item index to render. */
  start: number;
  /** One past the last item index to render. */
  end: number;
  /** Spacer heights, in px, standing in for the rows that are not mounted. */
  padTop: number;
  padBottom: number;
  /** False until geometry is known, or when the list is short enough to skip. */
  active: boolean;
};

export function useVirtualGrid({
  scrollRef,
  gridRef,
  count,
  /** Anything that changes tile size — the density toggle, for instance. */
  resetKey,
}: {
  scrollRef: React.RefObject<HTMLElement | null>;
  gridRef: React.RefObject<HTMLElement | null>;
  count: number;
  resetKey: unknown;
}): VirtualWindow {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [range, setRange] = useState({ startRow: 0, endRow: 0 });

  const enabled = count > VIRTUALIZE_THRESHOLD;

  // ── Measure ────────────────────────────────────────────────────────────────
  const measure = useCallback(() => {
    const grid = gridRef.current;
    const tile = grid?.querySelector<HTMLElement>(".tile");
    if (!grid || !tile) return;

    const styles = window.getComputedStyle(grid);
    // The resolved value is a track list like "190px 190px 190px".
    const columns = styles.gridTemplateColumns.split(" ").filter(Boolean).length;
    const gap = Number.parseFloat(styles.rowGap) || 0;
    const rowHeight = tile.getBoundingClientRect().height + gap;

    if (columns < 1 || rowHeight <= gap) return;

    setGeometry((prev) =>
      prev && prev.columns === columns && Math.abs(prev.rowHeight - rowHeight) < 0.5
        ? prev
        : { columns, rowHeight },
    );
  }, [gridRef]);

  // Measure before paint so the first virtualised frame is already correct.
  // Stale geometry from a previous list is harmless: this re-runs whenever the
  // list becomes long enough to virtualise or the tile size changes, and the
  // return value below ignores geometry entirely while disabled.
  useLayoutEffect(() => {
    if (enabled) measure();
  }, [enabled, resetKey, measure]);

  // Re-measure when the container resizes — a window resize or the sidebar
  // collapsing both change the column count.
  useEffect(() => {
    const grid = gridRef.current;
    if (!enabled || !grid || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(grid);
    return () => observer.disconnect();
  }, [enabled, gridRef, measure]);

  // ── Track scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!enabled || !scroller) return;

    if (!geometry) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const totalRows = Math.ceil(count / geometry.columns);
      const firstVisible = Math.floor(scroller.scrollTop / geometry.rowHeight);
      const visibleRows = Math.ceil(scroller.clientHeight / geometry.rowHeight);

      const startRow = Math.max(0, firstVisible - OVERSCAN_ROWS);
      const endRow = Math.min(totalRows, firstVisible + visibleRows + OVERSCAN_ROWS);

      setRange((prev) => (prev.startRow === startRow && prev.endRow === endRow ? prev : { startRow, endRow }));
    };

    // Coalesce to one update per frame: scroll fires far more often than the
    // window actually needs to move.
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };

    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [enabled, scrollRef, count, geometry]);

  if (!enabled || !geometry) {
    return { start: 0, end: count, padTop: 0, padBottom: 0, active: false };
  }

  const totalRows = Math.ceil(count / geometry.columns);
  const startRow = Math.min(range.startRow, Math.max(0, totalRows - 1));
  const endRow = Math.max(startRow + 1, Math.min(range.endRow, totalRows));

  return {
    start: startRow * geometry.columns,
    end: Math.min(count, endRow * geometry.columns),
    padTop: startRow * geometry.rowHeight,
    padBottom: Math.max(0, (totalRows - endRow) * geometry.rowHeight),
    active: true,
  };
}
