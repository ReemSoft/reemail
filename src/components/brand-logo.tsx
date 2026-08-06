import { cn } from "@/lib/utils";
import * as React from "react";

/**
 * Official MailMaestro brand mark — exact vector replica of the reference
 * envelope icon. Two colors only (#000000 → #3B82F6), transparent background,
 * sharp at any size, and tiny file size.
 */
export function BrandLogo({
  className,
  alt = "MailMaestro",
}: {
  className?: string;
  alt?: string;
}) {
  const gradientId = React.useId().replace(/:/g, "_");

  return (
    <svg
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={alt}
      role="img"
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2="512"
          y2="512"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#000000" />
          <stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
      </defs>

      {/* Envelope body with V-shaped top opening */}
      <path
        fill={`url(#${gradientId})`}
        d="M86 265 L86 155 L248 265 Q256 275 264 265 L426 155 L426 265 L426 370 Q426 386 410 386 L102 386 Q86 386 86 370 Z"
      />

      {/* Top flap */}
      <rect
        x="80"
        y="138"
        width="352"
        height="18"
        rx="9"
        fill={`url(#${gradientId})`}
      />
    </svg>
  );
}

