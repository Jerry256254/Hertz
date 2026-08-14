import CodeMirror from "@uiw/react-codemirror";
import { githubDarkInit, githubLightInit } from "@uiw/codemirror-theme-github";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { useEffect, useState } from "react";

const EXTENSION_LANG: Record<string, () => Extension> = {
  ts: javascript,
  tsx: javascript,
  js: javascript,
  jsx: javascript,
  mjs: javascript,
  cjs: javascript,
  py: python,
  json: json,
  html: html,
  htm: html,
  css: css,
  md: markdown,
  markdown: markdown,
};

function languageExtensionFor(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const factory = EXTENSION_LANG[ext];
  return factory ? [factory()] : [];
}

const themeVars = EditorView.theme({
  "&": { backgroundColor: "transparent", height: "100%" },
  ".cm-scroller": { fontFamily: "inherit" },
});

function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setIsDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDark;
}

export function CodeViewer({ path, content }: { path: string; content: string }) {
  const isDark = useIsDark();
  const theme = isDark
    ? githubDarkInit({ settings: { background: "transparent", gutterBackground: "transparent" } })
    : githubLightInit({ settings: { background: "transparent", gutterBackground: "transparent" } });

  return (
    <CodeMirror
      value={content}
      editable={false}
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
      extensions={[...languageExtensionFor(path), themeVars, EditorView.lineWrapping]}
      theme={theme}
      className="text-xs"
    />
  );
}
