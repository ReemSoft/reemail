import { Toaster as Sonner } from "sonner";
import { useLanguage } from "@/hooks/use-language";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { dir } = useLanguage();
  return (
    <Sonner
      className="toaster group"
      position="bottom-left"
      dir={dir}
      richColors
      duration={4000}
      visibleToasts={5}
      closeButton={false}
      gap={10}
      offset="1.25rem"
      toastOptions={{
        classNames: {
          toast:
            "group toast w-full sm:w-[min(22rem,calc(100vw-2rem))] p-4 rounded-xl border border-border bg-background/95 text-foreground shadow-float backdrop-blur-sm transition-all duration-300 ease-out",
          description: "group-[.toast]:text-muted-foreground text-sm leading-relaxed",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground group-[.toast]:hover:bg-primary/90",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground group-[.toast]:hover:bg-muted/80",
          title: "group-[.toast]:text-sm font-medium leading-snug",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
