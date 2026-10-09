// SPDX-License-Identifier: MIT
// Copyright (c) 2023 shadcn. See vendor/shadcn-tailwind-4.13.0.LICENSE.md.
import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  )
}

export { Skeleton }
