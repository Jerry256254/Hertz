import { useState } from "react";
import { Download, Eye, File, FileArchive, FileAudio, FileImage, FileText, FileVideo, X } from "lucide-react";
import type { MessageAttachment } from "../lib/types";

/** Czech byte formatting: "12 B", "340 kB", "1,2 MB". */
function formatBytesCs(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0).replace(".", ",")} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function iconFor(mimeType: string) {
  if (mimeType.startsWith("image/")) return FileImage;
  if (mimeType.startsWith("video/")) return FileVideo;
  if (mimeType.startsWith("audio/")) return FileAudio;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/") || mimeType.includes("officedocument") || mimeType.includes("msword") || mimeType.includes("ms-powerpoint") || mimeType.includes("ms-excel")) return FileText;
  if (mimeType.includes("zip") || mimeType.includes("tar") || mimeType.includes("gzip")) return FileArchive;
  return File;
}

/**
 * A file the agent sent to the user (presentation, HTML page, report…).
 * Filename, size, caption, a Stáhnout button, plus an inline preview for
 * images and a sandboxed preview toggle for HTML pages. Czech, no emoji.
 */
export function FileAttachmentCard({ attachment, projectId }: { attachment: MessageAttachment; projectId: string }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const downloadUrl = `/api/projects/${projectId}/attachments/${attachment.id}`;
  const previewUrl = `${downloadUrl}?inline=1`;
  const isImage = attachment.mimeType.startsWith("image/");
  const isHtml = attachment.mimeType === "text/html";
  const canPreview = isImage || isHtml;
  const Icon = iconFor(attachment.mimeType);

  return (
    <div className="overflow-hidden rounded-[16px] border border-border bg-bg-raised">
      {isImage && (
        <a href={previewUrl} target="_blank" rel="noreferrer" title="Otevřít obrázek">
          <img src={previewUrl} alt={attachment.filename} className="max-h-64 w-full object-cover" loading="lazy" />
        </a>
      )}
      {isHtml && previewOpen && (
        <iframe
          src={previewUrl}
          title={attachment.filename}
          sandbox=""
          className="h-80 w-full border-0 bg-white"
        />
      )}
      <div className="flex items-center gap-2.5 p-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-fg-muted">
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-[600] text-fg" title={attachment.filename}>
            {attachment.filename}
          </p>
          <p className="text-[12px] text-fg-muted">
            {attachment.caption ? `${attachment.caption} · ` : ""}
            {formatBytesCs(attachment.size)}
          </p>
        </div>
        {canPreview && !isImage && (
          <button
            type="button"
            onClick={() => setPreviewOpen((v) => !v)}
            className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12.5px] font-[600] text-fg-muted transition-colors hover:bg-bg-sunken hover:text-fg"
          >
            {previewOpen ? <X size={13} /> : <Eye size={13} />}
            {previewOpen ? "Skrýt náhled" : "Náhled"}
          </button>
        )}
        <a
          href={downloadUrl}
          download={attachment.filename}
          className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full bg-fg px-3.5 py-1.5 text-[12.5px] font-[600] text-fg-inverse transition-opacity hover:opacity-90"
        >
          <Download size={13} />
          Stáhnout
        </a>
      </div>
    </div>
  );
}
