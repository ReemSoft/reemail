import { cn } from "@/lib/utils";

/**
 * Official MailMaestro brand mark as a high-quality SVG.
 * Uses only the brand colors #000000 and #3B82F6 so every shade can be
 * tweaked later. The vector is tiny, sharp at any size, and renders instantly.
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
      {/* Envelope body */}
      <path
        d="M96 132c0-26.51 21.49-48 48-48h224c26.51 0 48 21.49 48 48v220c0 26.51-21.49 48-48 48H144c-26.51 0-48-21.49-48-48V132z"
        fill="#000000"
      />
      {/* Top flap */}
      <path
        d="M96 132 L256 250 L416 132 V124c0-13.255-10.745-24-24-24H120c-13.255 0-24 10.745-24 24v8z"
        fill="#3B82F6"
      />
      {/* Lightning / speed accent */}
      <path
        d="M288 180 L220 272 h52 l-28 80 96-104 h-52 z"
        fill="#3B82F6"
      />
    </svg>
  );
}
