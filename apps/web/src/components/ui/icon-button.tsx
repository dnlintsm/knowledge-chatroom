import * as React from "react";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** A button that shows only an icon, so it must be named with `aria-label`. */
const iconButtonVariants = cva(
  "grid shrink-0 place-items-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-default",
  {
    variants: {
      variant: {
        // Toolbar actions. `aria-pressed` shows a toggle that is on.
        ghost:
          "rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] aria-pressed:bg-[var(--card)] aria-pressed:text-[var(--foreground)] aria-pressed:shadow-sm",
        // The one main action of a surface, such as Send.
        brand: "rounded-[.5625rem] bg-brand text-brand-foreground enabled:hover:brightness-110 disabled:opacity-45",
      },
      size: {
        sm: "size-7 [&_svg]:size-4",
        // Grows to a 44px target on touch screens.
        md: "size-8.5 pointer-coarse:size-11 [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "ghost", size: "sm" },
  },
);

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {
  "aria-label": string;
}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn(iconButtonVariants({ variant, size }), className)} {...props} />
  ),
);
IconButton.displayName = "IconButton";

export { IconButton, iconButtonVariants };
