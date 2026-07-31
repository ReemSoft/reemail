import logoAsset from "@/assets/mailmaestro-logo.png.asset.json";
import { cn } from "@/lib/utils";

/**
 * Official MailMaestro brand mark.
 * Served from the CDN so it stays out of the JS bundle.
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
      src={logoAsset.url}
      alt={alt}
      width={64}
      height={64}
      loading="eager"
      decoding="async"
      className={cn("object-contain", className)}
    />
  );
}
