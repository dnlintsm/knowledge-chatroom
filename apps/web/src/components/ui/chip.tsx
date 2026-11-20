import * as React from "react";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A small labelled token: something Claude sees, or a prompt to pick. Use
 * `chipVariants` on a `<button>` when the chip does something.
 */
const chipVariants = cva(
  "flex max-w-full min-w-0 items-center gap-1 rounded-md [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Read-only context, such as the file Claude sees.
        context: "bg-[var(--card)] px-1.5 py-0.5 text-caption text-[var(--muted-foreground)]",
        // A label in a row of context chips, without a chip of its own.
        label: "px-0.5 py-0.5 text-caption text-[var(--muted-foreground)]",
        // A prompt to pick. The label wraps rather than being cut off.
        suggestion:
          "flex-initial items-start bg-surface-raised px-2 py-1.5 text-start text-label leading-[1.35] text-brand-text cursor-pointer enabled:hover:bg-brand-tint disabled:cursor-progress [&_svg]:mt-0.5 [&>span]:min-w-0 [&>span]:wrap-anywhere",
      },
    },
    defaultVariants: { variant: "context" },
  },
);

export interface ChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof chipVariants> {}

function Chip({ className, variant, ...props }: ChipProps) {
  return <span className={cn(chipVariants({ variant }), className)} {...props} />;
}

export { Chip, chipVariants };
