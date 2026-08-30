// ABOUTME: Provides the client-only Markdown-native Visual editor for article bodies.
// ABOUTME: Restricts editing to the safe OPAS grammar and stages image uploads through a typed seam.
"use client";

import "@mdxeditor/editor/style.css";

import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  ChangeCodeMirrorLanguage,
  CodeToggle,
  ConditionalContents,
  CreateLink,
  InsertCodeBlock,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  MDXEditor,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  useCodeBlockEditorContext,
  type CodeBlockEditorProps,
  type ImageUploadHandler,
  type MDXEditorMethods,
} from "@mdxeditor/editor";
import { useCallback, useMemo, useRef, useState, type ClipboardEvent } from "react";

import styles from "@/app/admin/content/article-visual-editor.module.css";
import { articleVisualBodyIssue } from "@/app/admin/content/article-source";
import { authenticatedAssetUrl } from "@/assets/identity";
import {
  articleImageUrlIssue,
  articleLinkUrlIssue,
} from "@/content/article-url-policy";

export type StageArticleImage = ImageUploadHandler;

type ArticleVisualEditorProps = {
  markdown: string;
  onChange: (markdown: string) => void;
  stageImage?: StageArticleImage;
};

function PlainTextCodeEditor({ code, language, meta }: CodeBlockEditorProps) {
  const { setCode, setLanguage, setMeta } = useCodeBlockEditorContext();

  return (
    <div className={styles.plainCodeBlock}>
      <div className={styles.plainCodeMeta}>
        <input
          aria-label="Code language"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
          placeholder="Language"
        />
        <input
          aria-label="Code metadata"
          value={meta}
          onChange={(event) => setMeta(event.target.value)}
          placeholder="Optional metadata"
        />
      </div>
      <textarea
        aria-label="Plain-text code block"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

const plainTextCodeDescriptor = {
  priority: 0,
  match: () => true,
  Editor: PlainTextCodeEditor,
};

function EditorToolbar() {
  return (
    <>
      <UndoRedo />
      <Separator />
      <BlockTypeSelect />
      <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
      <CodeToggle />
      <Separator />
      <ListsToggle options={["bullet", "number", "check"]} />
      <CreateLink />
      <InsertImage />
      <InsertTable />
      <InsertThematicBreak />
      <InsertCodeBlock />
      <ConditionalContents
        options={[
          {
            when: (editor) => editor?.editorType === "codeblock",
            contents: () => <ChangeCodeMirrorLanguage />,
          },
        ]}
      />
    </>
  );
}

function literalPastedText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>#!|{}])/g, "\\$1")
    .replace(/^(\s*)([-+>]|\d+[.)])(?=\s)/gmu, "$1\\$2");
}

export function ArticleVisualEditor({
  markdown,
  onChange,
  stageImage,
}: ArticleVisualEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const acceptedMarkdownRef = useRef(markdown);
  const [editorIssue, setEditorIssue] = useState<string | null>(null);

  const uploadImage = useCallback<NonNullable<ImageUploadHandler>>(
    async (file) => {
      if (!stageImage) {
        throw new Error("Image upload is not available yet. Insert an allowed image URL instead.");
      }

      const source = await stageImage(file);
      const issue = articleImageUrlIssue(source);
      if (issue) {
        throw new Error(issue);
      }
      return source;
    },
    [stageImage],
  );

  const plugins = useMemo(
    () => [
      headingsPlugin({ allowedHeadingLevels: [2, 3, 4, 5, 6] }),
      listsPlugin(),
      quotePlugin(),
      linkPlugin({ validateUrl: (url) => articleLinkUrlIssue(url) === null }),
      linkDialogPlugin({ showLinkTitleField: true }),
      tablePlugin(),
      thematicBreakPlugin(),
      codeBlockPlugin({
        codeBlockEditorDescriptors: [plainTextCodeDescriptor],
        defaultCodeBlockLanguage: "",
      }),
      codeMirrorPlugin({
        autoLoadLanguageSupport: false,
        codeBlockLanguages: {
          "": "Plain text",
          bash: "Bash",
          css: "CSS",
          html: "HTML",
          js: "JavaScript",
          json: "JSON",
          jsx: "JavaScript (React)",
          md: "Markdown",
          shell: "Shell",
          ts: "TypeScript",
          tsx: "TypeScript (React)",
          yaml: "YAML",
        },
      }),
      imagePlugin({
        imageUploadHandler: stageImage ? uploadImage : undefined,
        imagePreviewHandler: async (source) => authenticatedAssetUrl(source),
        disableImageResize: true,
        allowSetImageDimensions: false,
      }),
      toolbarPlugin({ toolbarContents: EditorToolbar }),
      markdownShortcutPlugin(),
    ],
    [stageImage, uploadImage],
  );

  function handleChange(nextMarkdown: string, initialMarkdownNormalize: boolean) {
    if (initialMarkdownNormalize) {
      return;
    }

    const issue = articleVisualBodyIssue(nextMarkdown);
    if (issue) {
      setEditorIssue(issue);
      editorRef.current?.setMarkdown(acceptedMarkdownRef.current);
      return;
    }

    acceptedMarkdownRef.current = nextMarkdown;
    setEditorIssue(null);
    onChange(nextMarkdown);
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const items = [...event.clipboardData.items];
    if (stageImage && items.some((item) => item.type.startsWith("image/"))) {
      return;
    }

    if (!event.clipboardData.types.includes("text/html")) {
      return;
    }

    const plainText = event.clipboardData.getData("text/plain");
    if (!plainText) {
      event.preventDefault();
      setEditorIssue("The pasted HTML contained no safe text to insert.");
      return;
    }

    event.preventDefault();
    editorRef.current?.insertMarkdown(literalPastedText(plainText));
  }

  return (
    <div onPasteCapture={handlePaste}>
      <MDXEditor
        ref={editorRef}
        markdown={markdown}
        trim={false}
        onChange={handleChange}
        onError={({ error }) => setEditorIssue(`Visual mode could not parse this source: ${error}`)}
        className={styles.editor}
        contentEditableClassName={styles.content}
        placeholder="Write a clear answer…"
        spellCheck
        suppressHtmlProcessing
        toMarkdownOptions={{
          bullet: "-",
          emphasis: "_",
          fence: "`",
          fences: true,
          listItemIndent: "one",
          strong: "*",
        }}
        plugins={plugins}
      />
      {editorIssue ? (
        <p className="m-0 border-t border-danger bg-background px-4 py-3 text-sm text-danger" role="alert">
          {editorIssue}
        </p>
      ) : null}
    </div>
  );
}
