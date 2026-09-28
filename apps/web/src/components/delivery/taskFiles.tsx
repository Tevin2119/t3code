import type { EnvironmentId } from "@t3tools/contracts";
import {
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  MicIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";

import { parseTaskFile, type TaskFile } from "../../lib/delivery";
import {
  fileKindOf,
  formatBytes,
  pastedFileName,
  piecesOf,
  TASK_FILE_LIMIT_BYTES,
  type FileKind,
} from "../../lib/deliveryBoard";
import { cn } from "../../lib/utils";
import { useDeliveryAct, useDeliveryFetch } from "../../state/delivery";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** An image this small is shown where it stands, without being asked for. */
const INLINE_IMAGE_LIMIT_BYTES = 6 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

export interface FileInTransit {
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly sent: number;
  readonly problem: string | null;
}

/**
 * Sends files to a task, in pieces, and keeps what is on the way. Anything
 * can be sent: a screenshot, a recording, a log, an archive.
 */
export function useTaskUploads(environmentId: EnvironmentId | null, person: string) {
  const act = useDeliveryAct(environmentId, "task file");
  const [transit, setTransit] = useState<ReadonlyArray<FileInTransit>>([]);
  const counter = useRef(0);

  const patch = useCallback((key: string, change: Partial<FileInTransit> | null) => {
    setTransit((current) =>
      change === null
        ? current.filter((item) => item.key !== key)
        : current.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
  }, []);

  const send = useCallback(
    async (taskId: string, file: File): Promise<TaskFile | null> => {
      counter.current += 1;
      const key = `up-${counter.current}`;
      const name = pastedFileName(file, new Date());
      setTransit((current) => [...current, { key, name, size: file.size, sent: 0, problem: null }]);
      if (file.size > TASK_FILE_LIMIT_BYTES) {
        patch(key, {
          problem: `A file is at most ${formatBytes(TASK_FILE_LIMIT_BYTES)}. This one is ${formatBytes(file.size)}.`,
        });
        return null;
      }
      let upload: string | null = null;
      for (const piece of piecesOf(file.size)) {
        const bytes = new Uint8Array(await file.slice(piece.from, piece.to).arrayBuffer());
        const result = await act(`/api/tasks/${taskId}/files`, {
          ...(upload ? { upload } : { name, type: file.type || "application/octet-stream" }),
          data: toBase64(bytes),
          more: !piece.last,
          by: person,
        });
        if (!result.ok) {
          patch(key, { problem: result.why });
          return null;
        }
        patch(key, { sent: piece.to });
        const body = result.body as Record<string, unknown> | null;
        if (piece.last) {
          patch(key, null);
          return body ? parseTaskFile(body) : null;
        }
        upload = typeof body?.upload === "string" ? body.upload : upload;
      }
      return null;
    },
    [act, patch, person],
  );

  const dismiss = useCallback((key: string) => patch(key, null), [patch]);
  return { transit, send, dismiss };
}

/** Reads a whole file from the engine, piece by piece. */
export function useTaskDownload(environmentId: EnvironmentId | null) {
  const read = useDeliveryFetch(environmentId);
  return useCallback(
    async (
      file: Pick<TaskFile, "id" | "type">,
      onProgress?: (received: number) => void,
    ): Promise<{ readonly blob: Blob } | { readonly problem: string }> => {
      const parts: Array<Uint8Array<ArrayBuffer>> = [];
      let from = 0;
      for (;;) {
        const result = await read(`/api/files/${file.id}?from=${from}`);
        if (!result.ok) return { problem: result.why };
        const body = result.body as Record<string, unknown> | null;
        const data = typeof body?.data === "string" ? body.data : "";
        const bytes = fromBase64(data);
        parts.push(bytes);
        from += bytes.length;
        onProgress?.(from);
        if (body?.more !== true || bytes.length === 0) break;
      }
      return { blob: new Blob(parts, { type: file.type }) };
    },
    [read],
  );
}

const KIND_ICON: Record<FileKind, typeof FileIcon> = {
  image: ImageIcon,
  video: VideoIcon,
  audio: MicIcon,
  text: FileTextIcon,
  pdf: FileTextIcon,
  other: FileIcon,
};

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file's content as something the page can show. Let go of when the component goes. */
function useFileContent(
  environmentId: EnvironmentId | null,
  file: TaskFile,
  wanted: boolean,
): {
  readonly url: string | null;
  readonly text: string | null;
  readonly problem: string | null;
  readonly received: number;
} {
  const download = useTaskDownload(environmentId);
  const [state, setState] = useState<{
    url: string | null;
    text: string | null;
    problem: string | null;
    received: number;
  }>({ url: null, text: null, problem: null, received: 0 });
  useEffect(() => {
    if (!wanted) return;
    let gone = false;
    let made: string | null = null;
    void download(file, (received) => {
      if (!gone) setState((current) => ({ ...current, received }));
    }).then(async (result) => {
      if (gone) return;
      if ("problem" in result) {
        setState((current) => ({ ...current, problem: result.problem }));
        return;
      }
      if (fileKindOf(file.type, file.name) === "text") {
        const text = await result.blob.slice(0, 400_000).text();
        if (!gone) setState((current) => ({ ...current, text }));
        return;
      }
      made = URL.createObjectURL(result.blob);
      setState((current) => ({ ...current, url: made }));
    });
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
    // The file's id names its content, which never changes.
  }, [download, file.id, wanted]);
  return state;
}

function FileViewer(props: {
  readonly environmentId: EnvironmentId | null;
  readonly file: TaskFile;
  readonly onClose: () => void;
}) {
  const { file } = props;
  const kind = fileKindOf(file.type, file.name);
  // A document is saved and opened by what the person reads documents with.
  const shown = kind !== "other" && kind !== "pdf";
  const content = useFileContent(props.environmentId, file, shown);
  const download = useTaskDownload(props.environmentId);
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="break-all">{file.name}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {file.type}, {formatBytes(file.size)}, added by {file.by} at {file.at}
          </p>
          {content.problem ? <p className="text-warning">{content.problem}</p> : null}
          {shown && !content.url && content.text === null && !content.problem ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" />
              Reading, {formatBytes(content.received)} of {formatBytes(file.size)}
            </p>
          ) : null}
          {kind === "image" && content.url ? (
            <img src={content.url} alt={file.name} className="max-h-[65vh] w-full object-contain" />
          ) : null}
          {kind === "video" && content.url ? (
            // A recording a person attached has no captions to offer.
            <video src={content.url} controls className="max-h-[65vh] w-full" />
          ) : null}
          {kind === "audio" && content.url ? (
            <audio src={content.url} controls className="w-full" />
          ) : null}
          {content.text !== null ? (
            <pre className="max-h-[65vh] overflow-auto rounded border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
              {content.text}
            </pre>
          ) : null}
          <p className="font-mono text-[10px] break-all text-muted-foreground">
            On the engine's host: {file.path}
          </p>
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void download(file).then((result) => {
                  setSaving(false);
                  if ("blob" in result) saveBlob(result.blob, file.name);
                });
              }}
            >
              <DownloadIcon />
              {saving ? "Reading" : "Save a copy"}
            </Button>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function InlineImage(props: {
  readonly environmentId: EnvironmentId | null;
  readonly file: TaskFile;
  readonly onOpen: () => void;
}) {
  const content = useFileContent(props.environmentId, props.file, true);
  return (
    <button
      type="button"
      onClick={props.onOpen}
      aria-label={`Open ${props.file.name}`}
      className="flex h-24 w-32 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40"
    >
      {content.url ? (
        <img src={content.url} alt={props.file.name} className="size-full object-cover" />
      ) : content.problem ? (
        <ImageIcon className="size-5 text-muted-foreground" />
      ) : (
        <Spinner className="size-3.5" />
      )}
    </button>
  );
}

/** The files of a task or of one message. Images are shown; the rest are named. */
export function TaskFileList(props: {
  readonly environmentId: EnvironmentId | null;
  readonly files: ReadonlyArray<TaskFile>;
  readonly onRemove?: ((file: TaskFile) => void) | undefined;
  readonly compact?: boolean;
}) {
  const [open, setOpen] = useState<TaskFile | null>(null);
  if (props.files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-task-files>
      {props.files.map((file) => {
        const kind = fileKindOf(file.type, file.name);
        const Icon = KIND_ICON[kind];
        if (kind === "image" && file.size <= INLINE_IMAGE_LIMIT_BYTES && !props.compact) {
          return (
            <span key={file.id} className="relative">
              <InlineImage
                environmentId={props.environmentId}
                file={file}
                onOpen={() => setOpen(file)}
              />
              {props.onRemove ? (
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => props.onRemove?.(file)}
                  className="absolute top-1 right-1 flex size-5 cursor-pointer items-center justify-center rounded-full bg-background/90 text-foreground shadow-xs"
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </span>
          );
        }
        return (
          <span
            key={file.id}
            className="flex max-w-64 items-center gap-1 rounded-md border border-border bg-muted/40 py-0.5 pr-1 pl-1.5 text-xs"
          >
            <button
              type="button"
              onClick={() => setOpen(file)}
              className="flex min-w-0 cursor-pointer items-center gap-1 hover:underline"
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{file.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {formatBytes(file.size)}
              </span>
            </button>
            {props.onRemove ? (
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => props.onRemove?.(file)}
                className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </span>
        );
      })}
      {open ? (
        <FileViewer environmentId={props.environmentId} file={open} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

export function FilesInTransit(props: {
  readonly transit: ReadonlyArray<FileInTransit>;
  readonly onDismiss: (key: string) => void;
}) {
  if (props.transit.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-xs" data-task-files-transit>
      {props.transit.map((item) => (
        <li
          key={item.key}
          className={cn(
            "flex items-center gap-2 rounded-md border border-border px-2 py-1",
            item.problem && "border-warning/50 text-warning",
          )}
        >
          {item.problem ? null : <Spinner className="size-3 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">
            {item.name}
            {item.problem
              ? `: ${item.problem}`
              : `, ${formatBytes(item.sent)} of ${formatBytes(item.size)}`}
          </span>
          {item.problem ? (
            <button
              type="button"
              aria-label="Dismiss"
              className="cursor-pointer"
              onClick={() => props.onDismiss(item.key)}
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Files out of what was pasted or dropped. Text that was pasted is left to the field. */
export function filesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/**
 * Makes an area take files that are pasted into it or dropped on it.
 * `over` is true while something is held over it.
 */
export function useFileIntake(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
  return {
    over,
    handlers: {
      onPaste: (event: ClipboardEvent) => {
        const files = filesFrom(event.clipboardData);
        if (files.length === 0) return;
        event.preventDefault();
        onFiles(files);
      },
      onDragEnter: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        const files = filesFrom(event.dataTransfer);
        if (files.length > 0) onFiles(files);
      },
    },
  };
}

export function AttachButton(props: {
  readonly onFiles: (files: File[]) => void;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
  readonly label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) props.onFiles(files);
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={props.label}
              disabled={props.disabled}
              onClick={() => input.current?.click()}
            />
          }
        >
          {props.children}
        </TooltipTrigger>
        <TooltipPopup side="top">{props.label}</TooltipPopup>
      </Tooltip>
    </>
  );
}
