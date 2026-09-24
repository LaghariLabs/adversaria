import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Extension } from "@tiptap/core";
import {
  Bold,
  Italic,
  Heading2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Code2,
  Undo2,
  Redo2,
} from "lucide-react";
import "../styles/notes-editor.css";

export interface NotesEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
  ariaLabel: string;
}

function sanitizeMarkdown(md: string): string {
  // Escape raw HTML tags like <img ...>, <div>, </span> so they are not parsed as HTML.
  // We only escape when '<' is followed by a letter, '/', '!' or '?' (HTML tag start).
  // This leaves markdown images ![alt](url) untouched and preserves autolinks behavior
  // enough for tests; the markdown manager's html safety fallback also encodes.
  return md.replace(/<(?=[a-zA-Z\/!?])/g, "&lt;");
}

// HTML safety: force all raw HTML to be treated as literal text, preventing
// e.g. <img src=x onerror=...> from becoming a real element.
const HtmlSafety = Extension.create({
  name: "htmlSafety",
  onBeforeCreate() {
    const manager = (this.editor as unknown as { markdown?: unknown }).markdown as
      | { isUnrecognizedHtml?: (html: string) => boolean }
      | undefined;
    if (manager && typeof manager.isUnrecognizedHtml === "function") {
      manager.isUnrecognizedHtml = () => true;
    }
  },
});

export default function NotesEditor(props: NotesEditorProps): JSX.Element {
  const { value, onChange, onBlur, placeholder, disabled, compact, ariaLabel } = props;
  const [isFocused, setIsFocused] = useState(false);

  const lastEmittedRef = useRef<string>(value);
  const prevValueRef = useRef<string>(value);
  const debounceRef = useRef<number | null>(null);
  const pendingMdRef = useRef<string | null>(null);

  // Keep refs in sync if value changes externally via props (initial case)
  // lastEmittedRef is updated when we emit; prevValueRef tracks previous prop value for append detection

  const editor = useEditor({
    extensions: [
      HtmlSafety,
      StarterKit.configure({
        // Keep StarterKit lists; TaskList is additive
        heading: { levels: [1, 2, 3] },
      }),
      Markdown,
      TaskList,
      TaskItem.configure({ nested: true }),
      Image.configure({ inline: false, allowBase64: true }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
    ],
    content: sanitizeMarkdown(value),
    contentType: "markdown",
    editable: !disabled,
    editorProps: {
      attributes: {
        class: "notes-editor-content",
        "aria-label": ariaLabel,
        role: "textbox",
        dir: "auto",
      },
      // Escape pasted HTML so it becomes literal text
      transformPastedHTML(html: string) {
        return html.replace(/</g, "&lt;");
      },
    },
    onCreate({ editor: ed }) {
      lastEmittedRef.current = value;
      prevValueRef.current = value;
      // Ensure HTML is forced literal for subsequent parses
      const manager = (ed as unknown as { markdown?: { isUnrecognizedHtml?: () => boolean } }).markdown;
      if (manager) {
        manager.isUnrecognizedHtml = () => true;
      }
    },
    onUpdate({ editor: ed }) {
      let md = "";
      try {
        md = ed.getMarkdown();
      } catch {
        return;
      }
      if (md === lastEmittedRef.current) return;
      pendingMdRef.current = md;
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        const pending = pendingMdRef.current;
        pendingMdRef.current = null;
        if (pending != null && pending !== lastEmittedRef.current) {
          lastEmittedRef.current = pending;
          onChange(pending);
        }
      }, 150);
    },
    onFocus() {
      setIsFocused(true);
    },
    onBlur() {
      setIsFocused(false);
      // Flush pending debounce on blur
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (pendingMdRef.current != null && pendingMdRef.current !== lastEmittedRef.current) {
        const pending = pendingMdRef.current;
        pendingMdRef.current = null;
        lastEmittedRef.current = pending;
        onChange(pending);
      }
      onBlur?.();
    },
  });

  // Handle external value changes (including pin-append)
  useEffect(() => {
    if (!editor) return;
    if (value === lastEmittedRef.current) {
      prevValueRef.current = value;
      return;
    }
    let currentMd = "";
    try {
      currentMd = editor.getMarkdown();
    } catch {
      currentMd = "";
    }
    if (value === currentMd) {
      lastEmittedRef.current = value;
      prevValueRef.current = value;
      return;
    }
    const prev = prevValueRef.current;
    const isAppend = prev !== "" && value.startsWith(prev) && value.length > prev.length;
    const hadFocus = editor.isFocused;
    editor.commands.setContent(sanitizeMarkdown(value), { contentType: "markdown", emitUpdate: false });
    lastEmittedRef.current = value;
    prevValueRef.current = value;
    if (isAppend && hadFocus) {
      // Move cursor to end only if already focused (pin-append case)
      editor.commands.focus("end");
    }
  }, [value, editor]);

  // Keep editable in sync with disabled prop
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  // Placeholder text is set at creation; updates rarely needed. No view access here to avoid
  // "editor view not available" errors during initial mount.

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    };
  }, []);

  if (!editor) return <div className="notes-editor" />;

  const toolbarClass =
    compact && !isFocused ? "notes-editor-toolbar notes-editor-toolbar--compact-hidden" : "notes-editor-toolbar";

  return (
    <div className={`notes-editor${compact ? " notes-editor--compact" : ""}${isFocused ? " is-focused" : ""}`}>
      <div className={toolbarClass} role="toolbar" aria-label="Formatting">
        <button
          type="button"
          aria-label="Bold"
          aria-pressed={editor.isActive("bold")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBold().run()}
          disabled={!!disabled}
        >
          <Bold size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Italic"
          aria-pressed={editor.isActive("italic")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          disabled={!!disabled}
        >
          <Italic size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Heading"
          aria-pressed={editor.isActive("heading", { level: 2 })}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          disabled={!!disabled}
        >
          <Heading2 size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Bullet list"
          aria-pressed={editor.isActive("bulletList")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          disabled={!!disabled}
        >
          <List size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Numbered list"
          aria-pressed={editor.isActive("orderedList")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          disabled={!!disabled}
        >
          <ListOrdered size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Task list"
          aria-pressed={editor.isActive("taskList")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          disabled={!!disabled}
        >
          <ListTodo size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Quote"
          aria-pressed={editor.isActive("blockquote")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          disabled={!!disabled}
        >
          <Quote size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Code block"
          aria-pressed={editor.isActive("codeBlock")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          disabled={!!disabled}
        >
          <Code2 size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Undo"
          aria-pressed={false}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!!disabled}
        >
          <Undo2 size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Redo"
          aria-pressed={false}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!!disabled}
        >
          <Redo2 size={14} aria-hidden="true" />
        </button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
