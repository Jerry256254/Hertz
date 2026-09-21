/** Brand tint for a channel kind icon chip. Unknown kinds get a neutral chip. */
export function channelChipClass(kind: string): string {
  switch (kind) {
    case "telegram":
      return "bg-[#229ed9]/15 text-[#229ed9]";
    case "discord":
      return "bg-[#5865f2]/15 text-[#8b90ff]";
    case "whatsapp":
      return "bg-[#25d366]/15 text-[#25d366]";
    default:
      return "bg-bg-sunken text-fg-muted";
  }
}

/** "Telegramu" / "Discordu" — for sentences like "Pokračuj v konverzaci v …". */
export function channelAppGenitive(kind: string | undefined): string {
  switch (kind) {
    case "telegram":
      return "Telegramu";
    case "discord":
      return "Discordu";
    default:
      return "aplikace";
  }
}
