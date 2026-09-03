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
  cancelLinkEdit$,
  closeImageDialog$,
  imageDialogState$,
  imageUploadHandler$,
  linkDialogState$,
  openNewImageDialog$,
  removeLink$,
  saveImage$,
  switchFromPreviewToLinkEdit$,
  updateLink$,
  useCellValue,
  useCodeBlockEditorContext,
  usePublisher,
  type CodeBlockEditorProps,
  type EditLinkDialog,
  type EditingImageDialogState,
  type ImageUploadHandler,
  type MDXEditorMethods,
  type NewImageDialogState,
} from "@mdxeditor/editor";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";

import {
  ArticleImageForm,
  ArticleLinkForm,
} from "@/app/admin/content/article-authoring-controls";
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
  readOnly?: boolean;
  stageImage?: StageArticleImage;
};

type PendingImageContextValue = {
  pendingImageFile: File | null;
  setPendingImageFile: (file: File | null) => void;
};

const PendingImageContext = createContext<PendingImageContextValue | null>(null);

function usePendingImage() {
  const value = useContext(PendingImageContext);
  if (!value) {
    throw new Error("The article image dialog must be rendered inside its editor.");
  }
  return value;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

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

function ArticleLinkEditDialog({ state }: { state: EditLinkDialog }) {
  const updateLink = usePublisher(updateLink$);
  const cancelLinkEdit = usePublisher(cancelLinkEdit$);
  const [url, setUrl] = useState(state.url);
  const [text, setText] = useState(state.text);
  const [title, setTitle] = useState(state.title);
  const [urlIssue, setUrlIssue] = useState<string | null>(null);

  function submitLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const normalizedUrl = url.trim();
    const issue = articleLinkUrlIssue(normalizedUrl);
    if (issue) {
      setUrlIssue(issue);
      return;
    }

    updateLink({
      url: normalizedUrl,
      text: text.trim(),
      title: title.trim(),
    });
  }

  return createPortal(
    <div className={styles.dialogLayer}>
      <section
        className={styles.dialogCard}
        role="dialog"
        aria-modal="true"
        aria-labelledby="opas-editor-link-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancelLinkEdit();
          }
        }}
      >
        <h2 id="opas-editor-link-dialog-title" className={styles.dialogTitle}>
          Add or edit link
        </h2>
        <ArticleLinkForm
          url={url}
          title={title}
          text={text}
          showTextField={state.withAnchorText}
          urlIssue={urlIssue}
          onUrlChange={(value) => {
            setUrl(value);
            setUrlIssue(null);
          }}
          onTitleChange={setTitle}
          onTextChange={setText}
          onSubmit={submitLink}
          onCancel={cancelLinkEdit}
        />
      </section>
    </div>,
    document.body,
  );
}

function ArticleLinkDialog() {
  const state = useCellValue(linkDialogState$);
  const closeLinkDialog = usePublisher(linkDialogState$);
  const editLink = usePublisher(switchFromPreviewToLinkEdit$);
  const removeLink = usePublisher(removeLink$);

  if (state.type === "inactive") {
    return <></>;
  }

  if (state.type === "edit") {
    return (
      <ArticleLinkEditDialog
        key={`${state.linkNodeKey}:${state.initialUrl}`}
        state={state}
      />
    );
  }

  const external = /^https?:/iu.test(state.href ?? state.url);
  return createPortal(
    <div className={styles.linkOptions} role="group" aria-label="Link options">
      <a
        href={state.href ?? "about:blank"}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
        className={styles.linkDestination}
      >
        {state.url}
      </a>
      <button type="button" onClick={() => editLink()}>
        Edit link
      </button>
      <button type="button" onClick={() => removeLink()}>
        Remove link
      </button>
      <button type="button" onClick={() => closeLinkDialog({ type: "inactive" })}>
        Close
      </button>
    </div>,
    document.body,
  );
}

type ActiveImageDialogState = EditingImageDialogState | NewImageDialogState;

function ArticleImageDialogSession({ state }: { state: ActiveImageDialogState }) {
  const imageUploadHandler = useCellValue(imageUploadHandler$);
  const saveImage = usePublisher(saveImage$);
  const closeImageDialog = usePublisher(closeImageDialog$);
  const { pendingImageFile, setPendingImageFile } = usePendingImage();
  const initialValues = state.type === "editing" ? state.initialValues : undefined;
  const initialAltText = initialValues?.altText ?? "";
  const [source, setSource] = useState(initialValues?.src ?? "");
  const [altText, setAltText] = useState(initialAltText);
  const [title, setTitle] = useState(initialValues?.title ?? "");
  const [decorative, setDecorative] = useState(
    state.type === "editing" && initialAltText.trim() === "",
  );
  const [selectedFile, setSelectedFile] = useState<File | null>(pendingImageFile);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const focusAltText = Boolean(pendingImageFile) || state.type === "editing";

  function cancelImage() {
    setPendingImageFile(null);
    closeImageDialog();
  }

  async function submitImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const normalizedAltText = altText.trim();
    if (!decorative && !normalizedAltText) {
      setIssue("Add alternative text or mark the image as decorative.");
      return;
    }

    setBusy(true);
    setIssue(null);
    try {
      let resolvedSource = source.trim();
      if (selectedFile) {
        if (!imageUploadHandler) {
          throw new Error("Image upload is unavailable. Use an allowed image URL instead.");
        }
        resolvedSource = await imageUploadHandler(selectedFile);
      }

      if (!resolvedSource) {
        throw new Error("Choose an image or enter an allowed image URL.");
      }
      const sourceIssue = articleImageUrlIssue(resolvedSource);
      if (sourceIssue) {
        throw new Error(sourceIssue);
      }

      setPendingImageFile(null);
      saveImage({
        src: resolvedSource,
        altText: decorative ? "" : normalizedAltText,
        title: title.trim(),
      });
    } catch (error) {
      setIssue(errorMessage(error, "The image could not be added. Try again."));
      setBusy(false);
    }
  }

  return createPortal(
    <div className={styles.dialogLayer}>
      <section
        className={styles.dialogCard}
        role="dialog"
        aria-modal="true"
        aria-labelledby="opas-editor-image-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            event.stopPropagation();
            cancelImage();
          }
        }}
      >
        <h2 id="opas-editor-image-dialog-title" className={styles.dialogTitle}>
          {state.type === "editing" ? "Edit image" : "Add image"}
        </h2>
        <ArticleImageForm
          source={source}
          altText={altText}
          title={title}
          decorative={decorative}
          canUpload={Boolean(imageUploadHandler)}
          selectedFileName={selectedFile?.name ?? null}
          busy={busy}
          issue={issue}
          focusAltText={focusAltText}
          onFileChange={(file) => {
            setSelectedFile(file);
            setIssue(null);
          }}
          onSourceChange={(value) => {
            setSource(value);
            setIssue(null);
          }}
          onAltTextChange={(value) => {
            setAltText(value);
            setIssue(null);
          }}
          onTitleChange={setTitle}
          onDecorativeChange={(value) => {
            setDecorative(value);
            setIssue(null);
          }}
          onSubmit={(event) => void submitImage(event)}
          onCancel={cancelImage}
        />
      </section>
    </div>,
    document.body,
  );
}

function ArticleImageDialog() {
  const state = useCellValue(imageDialogState$);
  const openImageDialog = usePublisher(openNewImageDialog$);
  const { pendingImageFile } = usePendingImage();

  useEffect(() => {
    if (pendingImageFile && state.type === "inactive") {
      openImageDialog();
    }
  }, [openImageDialog, pendingImageFile, state.type]);

  if (state.type === "inactive") {
    return null;
  }

  return (
    <ArticleImageDialogSession
      key={state.type === "editing" ? state.nodeKey : "new-image"}
      state={state}
    />
  );
}

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
  readOnly = false,
  stageImage,
}: ArticleVisualEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const acceptedMarkdownRef = useRef(markdown);
  const [editorIssue, setEditorIssue] = useState<string | null>(null);
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);

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
      linkDialogPlugin({
        LinkDialog: ArticleLinkDialog,
        showLinkTitleField: true,
      }),
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
        ImageDialog: ArticleImageDialog,
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
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (imageItem) {
      event.preventDefault();
      event.stopPropagation();
      const file = imageItem.getAsFile();
      if (!file) {
        setEditorIssue("Use Insert image to add this image with alternative text.");
        return;
      }
      setEditorIssue(null);
      setPendingImageFile(file);
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

  function dragContainsImage(event: DragEvent<HTMLDivElement>) {
    return [...event.dataTransfer.items].some((item) => item.type.startsWith("image/"));
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (dragContainsImage(event)) {
      event.preventDefault();
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    const imageItem = [...event.dataTransfer.items].find((item) =>
      item.type.startsWith("image/"),
    );
    if (!imageItem) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const file =
      imageItem.getAsFile() ??
      [...event.dataTransfer.files].find((candidate) =>
        candidate.type.startsWith("image/"),
      ) ??
      null;
    if (!file) {
      setEditorIssue("Use Insert image to add this image with alternative text.");
      return;
    }
    setEditorIssue(null);
    setPendingImageFile(file);
  }

  return (
    <div
      onPasteCapture={readOnly ? undefined : handlePaste}
      onDragOverCapture={readOnly ? undefined : handleDragOver}
      onDropCapture={readOnly ? undefined : handleDrop}
    >
      <PendingImageContext.Provider value={{ pendingImageFile, setPendingImageFile }}>
        <MDXEditor
          ref={editorRef}
          markdown={markdown}
          readOnly={readOnly}
          trim={false}
          onChange={handleChange}
          onError={({ error }) =>
            setEditorIssue(`Visual mode could not parse this source: ${error}`)
          }
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
      </PendingImageContext.Provider>
      {editorIssue ? (
        <p className="m-0 border-t border-danger bg-background px-4 py-3 text-sm text-danger" role="alert">
          {editorIssue}
        </p>
      ) : null}
    </div>
  );
}
