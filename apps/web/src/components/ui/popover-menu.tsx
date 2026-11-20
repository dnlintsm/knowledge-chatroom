import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A button that opens a short list of actions above it. Built on `<details>`,
 * so it opens without script; Escape closes it and returns focus to the
 * trigger. The menu is placed against the nearest positioned ancestor.
 */
function PopoverMenu({ trigger, triggerClassName, className, children, onKeyDown, ...props }:
  Omit<React.DetailsHTMLAttributes<HTMLDetailsElement>, "children"> & {
    trigger: React.ReactNode;
    triggerClassName?: string;
    children: React.ReactNode;
  }) {
  return (
    <details className={className} {...props} onKeyDown={(event) => {
      onKeyDown?.(event);
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }}>
      <summary className={cn("list-none whitespace-nowrap [&::-webkit-details-marker]:hidden", triggerClassName)}>{trigger}</summary>
      <div className="absolute inset-x-2 bottom-[calc(100%+.375rem)] z-31 grid rounded-[.625rem] border border-[var(--border)] bg-[var(--card)] p-1 shadow-[0_.375rem_1.125rem_#0002]">
        {children}
      </div>
    </details>
  );
}

/** Closes the menu that holds this element. */
function closePopoverMenu(element: Element) {
  element.closest("details")?.removeAttribute("open");
}

function PopoverMenuItem({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button"
      className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-start text-body cursor-pointer hover:bg-brand-tint [&_svg]:size-3.5 [&_svg]:shrink-0", className)}
      {...props} />
  );
}

export { PopoverMenu, PopoverMenuItem, closePopoverMenu };
