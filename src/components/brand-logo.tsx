import { cn } from "@/lib/utils";

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
          id="brandGradient"
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
        fill="url(#brandGradient)"
        d="M91 199
           L91 352
           Q91 372.5 111 372.5
           L399.5 372.5
           Q419.5 372.5 419.5 352
           L419.5 199
           L341 179
           Q255.5 159 170 179
           Z"
      />

      {/* Top flap */}
      <rect
        x="91"
        y="139"
        width="328.5"
        height="20"
        rx="10"
        fill="url(#brandGradient)"
      />
    </svg>
  );
}
