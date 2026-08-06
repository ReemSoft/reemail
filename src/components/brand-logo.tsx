import { cn } from "@/lib/utils";
import logoAsset from "@/assets/mailmaestro-mark-v12.svg.asset.json";

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
      width={1319}
      height={939}
      loading="eager"
      decoding="async"
      className={cn("object-contain object-center", className)}
    />
  );
}


