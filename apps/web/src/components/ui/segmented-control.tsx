import * as React from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

/**
 * Switches between views of one thing, such as an answer and its sources. Each
 * item is a toggle button (`aria-pressed`), so the group needs an `aria-label`.
 */
function SegmentedControl({ className, ...props }: React.HTMLAttributes<HTMLDivElement> & { "aria-label": string }) {
  return <div role="group" className={cn("flex items-center gap-1 border-b border-[var(--border)] pb-1", className)} {...props} />;
}

function SegmentedControlItem({ className, selected, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }) {
  return (
    <button type="button" aria-pressed={selected}
      className={cn(buttonVariants({ variant: "quiet", size: "xs" }), className)} {...props} />
  );
}

export { SegmentedControl, SegmentedControlItem };
