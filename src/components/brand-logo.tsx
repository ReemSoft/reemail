import { cn } from "@/lib/utils";
import logoAsset from "@/assets/mailmaestro-envelope-original.png.asset.json";

/**
 * Official MailMaestro brand mark.
 * Uses the original uploaded transparent artwork without cropping or recompression.
 */
export function BrandLogo({
  className,
  alt = "MailMaestro",
  variant = "default",
}: {
  className?: string;
  alt?: string;
  variant?: "default" | "white";
}) {
  return (
    <img
      src={logoAsset.url}
      alt={alt}
      width={1024}
      height={1024}
      loading="eager"
      decoding="async"
      className={cn(
        "object-contain object-center",
        variant === "white" && "bg-white",
        className,
      )}
    />
  );
}
