// Soft, eye-friendly palette for sender folders. Deliberately light tones
// only (no dark colors) so folder chips stay readable in the sidebar.
export interface SenderFolderColor {
  key: string;
  /** Swatch / icon color. */
  hex: string;
  /** Very light background used behind the folder icon. */
  soft: string;
}

export const SENDER_FOLDER_COLORS: SenderFolderColor[] = [
  { key: "blue", hex: "#5B9BD5", soft: "#E8F1FB" },
  { key: "teal", hex: "#4FB3A6", soft: "#E6F5F3" },
  { key: "green", hex: "#7BB661", soft: "#EDF6E7" },
  { key: "amber", hex: "#E0A94F", soft: "#FBF2E1" },
  { key: "coral", hex: "#E8836F", soft: "#FCEDE9" },
  { key: "pink", hex: "#DE8AB0", soft: "#FBEBF3" },
  { key: "violet", hex: "#9C8AD9", soft: "#F0ECFB" },
  { key: "slate", hex: "#8A97A8", soft: "#EEF1F5" },
];

export function senderFolderColor(key: string | undefined): SenderFolderColor {
  return SENDER_FOLDER_COLORS.find((c) => c.key === key) ?? SENDER_FOLDER_COLORS[0]!;
}
