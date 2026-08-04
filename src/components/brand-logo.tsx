import { cn } from "@/lib/utils";

/**
 * Official MailMaestro brand mark.
 * Served locally as an optimized 128x128 PNG with transparent rounded corners.
 */
export function BrandLogo({
  className,
  alt = "MailMaestro",
}: {
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src="/favicon.png"
      alt={alt}
      width={128}
      height={128}
      loading="eager"
      decoding="async"
      className={cn("object-contain", className)}
    />
  );
}
