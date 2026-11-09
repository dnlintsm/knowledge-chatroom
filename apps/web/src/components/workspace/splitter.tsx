"use client";

import { useRef } from "react";

/**
 * Vertical drag handle between panes. Reports the horizontal distance moved
 * since the drag started, so callers clamp against the width they started at.
 */
export function Splitter({
  label,
  onDragStart,
  onDrag,
  onReset,
}: {
  label: string;
  onDragStart: () => void;
  onDrag: (deltaX: number) => void;
  onReset?: () => void;
}) {
  const startX = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label} (double-click to reset)`}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        startX.current = e.clientX;
        onDragStart();
      }}
      onPointerMove={(e) => {
        if (startX.current !== null) onDrag(e.clientX - startX.current);
      }}
      onPointerUp={() => (startX.current = null)}
      onPointerCancel={() => (startX.current = null)}
      className="group relative z-10 w-px cursor-col-resize bg-[var(--border)] max-lg:hidden"
    >
      {/* Wider invisible hit area, highlighted while hovering. */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5 group-hover:bg-[var(--ring)]/40 group-active:bg-[var(--ring)]/60" />
    </div>
  );
}
