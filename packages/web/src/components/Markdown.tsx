import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Download } from "lucide-react";

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String(children ?? "").replace(/\n$/, "");
  const lang = (className ?? "").replace("language-", "").replace("language", "").trim() || "text";

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  function download() {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kod.${lang === "text" ? "txt" : lang}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="relative mb-3 overflow-hidden rounded-[14px] border border-border bg-[#101014] last:mb-0">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="mono text-[11px] text-fg-subtle">{lang}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => void download()} title="Stáhnout" className="rounded-full p-1.5 text-fg-muted hover:bg-bg-sunken hover:text-fg">
            <Download size={13} />
          </button>
          <button onClick={() => void copy()} title="Kopírovat" className="rounded-full p-1.5 text-fg-muted hover:bg-bg-sunken hover:text-fg">
            {copied ? <Check size={13} className="text-live" /> : <Copy size={13} />}
          </button>
        </div>
      </div>
      <code className={`mono block overflow-x-auto p-3 text-[13px] leading-relaxed text-fg ${className ?? ""}`}>
        {children}
      </code>
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body text-[14px] leading-relaxed text-fg">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="font-[600] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          h1: ({ children }) => <h1 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="mb-3 border-l-2 border-accent pl-3 text-fg-muted last:mb-0">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-border" />,
          table: ({ children }) => (
            <div className="mb-3 overflow-x-auto rounded-[14px] border border-border">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-bg-sunken">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b border-border px-2.5 py-1.5 text-left font-medium text-fg-muted">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-border px-2.5 py-1.5">{children}</td>,
          code: ({ className, children }) => {
            const isBlock = className?.includes("language-");
            if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
            return <code className="mono rounded-[8px] bg-bg-sunken px-1.5 py-0.5 text-[13px]">{children}</code>;
          },
          pre: ({ children }) => <pre className="mb-3 last:mb-0">{children}</pre>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
