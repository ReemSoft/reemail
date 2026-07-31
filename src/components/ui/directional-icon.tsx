import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  type LucideProps,
} from "lucide-react";
import { useLanguage } from "@/hooks/use-language";

/**
 * Direction-aware arrows.
 * "Forward" follows the reading direction (right in LTR/EN, left in RTL/AR).
 * "Backward" is the exact mirror.
 */
export function ArrowForward(props: LucideProps) {
  const { lang } = useLanguage();
  const Icon = lang === "ar" ? ArrowLeft : ArrowRight;
  return <Icon {...props} />;
}

export function ArrowBackward(props: LucideProps) {
  const { lang } = useLanguage();
  const Icon = lang === "ar" ? ArrowRight : ArrowLeft;
  return <Icon {...props} />;
}

export function ChevronForward(props: LucideProps) {
  const { lang } = useLanguage();
  const Icon = lang === "ar" ? ChevronLeft : ChevronRight;
  return <Icon {...props} />;
}

export function ChevronBackward(props: LucideProps) {
  const { lang } = useLanguage();
  const Icon = lang === "ar" ? ChevronRight : ChevronLeft;
  return <Icon {...props} />;
}
