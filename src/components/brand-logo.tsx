import { cn } from "@/lib/utils";

/**
 * Official MailMaestro brand mark.
 * Served locally as an optimized 64x64 PNG.
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
      width={64}
      height={64}
      loading="eager"
      decoding="async"
      className={cn("object-contain", className)}
    />
  );
}
