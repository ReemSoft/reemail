import { cn } from "@/lib/utils";
import logoAsset from "@/assets/mailmaestro-mark-v3.png.asset.json";

/**
 * Official MailMaestro brand mark.
 * Uses the original uploaded transparent artwork without cropping or recompression.
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
      width={1024}
      height={1024}
      loading="eager"
      decoding="async"
      className={cn("object-contain object-center", className)}
    />
  );
}
