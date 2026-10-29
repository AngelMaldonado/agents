import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-1 rounded-md border border-transparent bg-clip-padding text-xs/relaxed font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-icon",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        destructive:
          "border-destructive/20 bg-danger-soft text-danger-on-soft hover:border-destructive/40 hover:bg-danger-soft hover:text-danger-on-soft hover:brightness-95 focus-visible:ring-destructive/30 dark:hover:brightness-125",
        "danger-ghost": "text-danger-on-soft hover:bg-danger-soft hover:text-danger-on-soft focus-visible:bg-danger-soft focus-visible:ring-destructive/30",
        "danger-outline": "border-destructive/30 text-danger-on-soft hover:border-destructive/50 hover:bg-danger-soft hover:text-danger-on-soft focus-visible:bg-danger-soft focus-visible:ring-destructive/30",
        outline:
          "border-border hover:bg-input/50 hover:text-foreground dark:bg-input/30 aria-expanded:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-control px-2",
        xs: "h-control-xs rounded-sm px-2 text-2xs [&_svg:not([class*='size-'])]:size-icon-sm",
        sm: "h-control-sm px-2",
        lg: "h-control-lg px-2.5",
        icon: "size-control",
        "icon-xs": "size-control-xs rounded-sm [&_svg:not([class*='size-'])]:size-icon-sm",
        "icon-sm": "size-control-sm",
        "icon-lg": "size-control-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
