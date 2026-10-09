// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { ArrowDownToLine, ChevronLeft, ChevronRight, File, Link, Loader2, RotateCcw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, formatBytes, type FileItem } from "@/lib/files";

type FileViewerProps = {
  open: boolean;
  files: FileItem[];
  fileId: string;
  onNavigate: (file: FileItem) => void;
  onClose: () => void;
  onDownload: (file: FileItem) => void;
  onShare: (file: FileItem) => void;
};

type PreviewState = { status: "loading" | "ready" | "empty" | "error"; kind?: "image" | "video" | "audio" | "text"; url?: string; text?: string; message?: string };

const MAX_IMAGE_CACHE_SIZE = 25 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const typeName = (file: FileItem) => file.mime.startsWith("image/") ? "Image" : file.mime.startsWith("video/") ? "Video" : file.mime.startsWith("audio/") ? "Audio" : file.name.split(".").pop()?.toUpperCase() || "File";
const isTypingTarget = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "VIDEO", "AUDIO"].includes(target.tagName));

export function FileViewer({ open, files, fileId, onNavigate, onClose, onDownload, onShare }: FileViewerProps) {
  const currentIndex = useMemo(() => files.findIndex(file => file.id === fileId), [files, fileId]);
  const file = currentIndex >= 0 ? files[currentIndex] : undefined;
  const previous = currentIndex > 0 ? files[currentIndex - 1] : undefined;
  const next = currentIndex >= 0 && currentIndex < files.length - 1 ? files[currentIndex + 1] : undefined;
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const [previewFileId, setPreviewFileId] = useState("");
  const [mediaReady, setMediaReady] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [canZoom, setCanZoom] = useState(false);
  const [retry, setRetry] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const requestId = useRef(0);
  const imageUrls = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const zoomPoint = useRef<{ x: number; y: number } | null>(null);

  const revokeImages = () => {
    imageUrls.current.forEach(url => URL.revokeObjectURL(url));
    imageUrls.current.clear();
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; revokeImages(); };
  }, []);

  useEffect(() => {
    if (!open) revokeImages();
  }, [open]);

  useEffect(() => {
    if (!open || !file || currentIndex < 0) return;
    const controller = new AbortController();
    const thisRequest = ++requestId.current;
    const isCurrent = () => mounted.current && thisRequest === requestId.current && !controller.signal.aborted;
    const isImage = IMAGE_MIMES.has(file.mime);
    const isVideo = file.mime === "video/mp4" || file.mime === "video/webm";
    const isAudio = file.mime.startsWith("audio/");
    const isText = file.mime.startsWith("text/") && file.size < 1_000_000;
    if (!isImage && !isVideo && !isAudio && !isText) return () => controller.abort();
    // A cached (prefetched) image shows immediately, with no signed-URL round trip.
    const cached = isImage ? imageUrls.current.get(file.id) : undefined;
    queueMicrotask(() => {
      if (!isCurrent()) return;
      setPreview(cached ? { status: "ready", kind: "image", url: cached } : { status: "loading" });
      setPreviewFileId(file.id);
      setMediaReady(false);
      setDimensions(null);
      setCanZoom(false);
      setZoomed(false);
    });
    (async () => {
      try {
        if (cached) return;
        const signed = await api<{ url: string; previewable: boolean }>(`/files/${file.id}/download?preview=1`, { signal: controller.signal });
        if (!isCurrent()) return;
        if (!signed.previewable && !isText) { setPreview({ status: "empty" }); setPreviewFileId(file.id); return; }
        if (isText) {
          const response = await fetch(signed.url, { signal: controller.signal });
          if (!response.ok) throw new Error("Preview could not be loaded.");
          const text = await response.text();
          if (isCurrent()) { setPreview({ status: "ready", kind: "text", text }); setPreviewFileId(file.id); }
          return;
        }
        if (isImage && file.size <= MAX_IMAGE_CACHE_SIZE) {
          let url = imageUrls.current.get(file.id);
          if (!url) {
            const response = await fetch(signed.url, { signal: controller.signal });
            if (!response.ok) throw new Error("Preview could not be loaded.");
            url = URL.createObjectURL(await response.blob());
            if (!isCurrent()) { URL.revokeObjectURL(url); return; }
            imageUrls.current.set(file.id, url);
          }
          setPreview({ status: "ready", kind: "image", url });
          setPreviewFileId(file.id);
          return;
        }
        setPreview({ status: "ready", kind: isImage ? "image" : isVideo ? "video" : "audio", url: signed.url });
        setPreviewFileId(file.id);
      } catch (error) {
        if (controller.signal.aborted || !mounted.current || thisRequest !== requestId.current) return;
        setPreview({ status: "error", message: (error as Error).message || "Preview could not be loaded." });
        setPreviewFileId(file.id);
      }
    })();
    return () => controller.abort();
    // Keyed on identity, not the object: the 30s list refresh replaces every FileItem and must not reload (or restart) the open preview.
  }, [open, file?.id, file?.mime, file?.size, retry]);

  useEffect(() => {
    if (!open || currentIndex < 0) return;
    for (const [id, url] of imageUrls.current) {
      const position = files.findIndex(candidate => candidate.id === id);
      if (position < 0 || Math.abs(position - currentIndex) > 2) { URL.revokeObjectURL(url); imageUrls.current.delete(id); }
    }
    const candidates = [previous, next].filter((candidate): candidate is FileItem => !!candidate && IMAGE_MIMES.has(candidate.mime) && candidate.size <= MAX_IMAGE_CACHE_SIZE);
    const controllers: AbortController[] = [];
    let cancelled = false;
    candidates.forEach(candidate => {
      if (imageUrls.current.has(candidate.id)) return;
      const controller = new AbortController();
      controllers.push(controller);
      void (async () => {
        try {
          const signed = await api<{ url: string; previewable: boolean }>(`/files/${candidate.id}/download?preview=1`, { signal: controller.signal });
          if (!signed.previewable || cancelled || controller.signal.aborted) return;
          const response = await fetch(signed.url, { signal: controller.signal });
          if (!response.ok || cancelled || controller.signal.aborted) return;
          const url = URL.createObjectURL(await response.blob());
          if (cancelled || controller.signal.aborted || !mounted.current) URL.revokeObjectURL(url);
          else imageUrls.current.set(candidate.id, url);
        } catch { /* Prefetch is opportunistic; the active file reports its own errors. */ }
      })();
    });
    return () => { cancelled = true; controllers.forEach(controller => controller.abort()); };
  }, [open, currentIndex, files, previous, next]);

  const toggleZoom = useCallback((event?: React.MouseEvent<HTMLImageElement>) => {
    if (!canZoom) return;
    const nextZoom = !zoomed;
    const image = imageRef.current;
    const stage = stageRef.current;
    let point = { x: image?.naturalWidth ? image.naturalWidth / 2 : 0, y: image?.naturalHeight ? image.naturalHeight / 2 : 0 };
    if (event && image) {
      const rect = image.getBoundingClientRect();
      point = { x: ((event.clientX - rect.left) / rect.width) * image.naturalWidth, y: ((event.clientY - rect.top) / rect.height) * image.naturalHeight };
    }
    setZoomed(nextZoom);
    zoomPoint.current = nextZoom ? point : null;
    if (!nextZoom && stage) { stage.scrollLeft = 0; stage.scrollTop = 0; }
  }, [canZoom, zoomed]);

  // Scroll after the zoomed layout commits, so the clicked point lands in the middle of the stage.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const point = zoomPoint.current;
    if (!zoomed || !stage || !point) return;
    stage.scrollLeft = Math.max(0, point.x - stage.clientWidth / 2);
    stage.scrollTop = Math.max(0, point.y - stage.clientHeight / 2);
    zoomPoint.current = null;
  }, [zoomed]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === "ArrowLeft" && previous) { event.preventDefault(); onNavigate(previous); }
      if (event.key === "ArrowRight" && next) { event.preventDefault(); onNavigate(next); }
      if (event.key.toLowerCase() === "z" && canZoom) { event.preventDefault(); toggleZoom(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, previous, next, canZoom, onNavigate, toggleZoom]);

  useEffect(() => {
    if (!imageRef.current || preview.kind !== "image" || preview.status !== "ready") return;
    const update = () => {
      const image = imageRef.current;
      if (!image || image.classList.contains("is-actual")) return;
      setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
      setCanZoom(image.naturalWidth > image.clientWidth + 1 || image.naturalHeight > image.clientHeight + 1);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [preview.kind, preview.status, preview.url]);

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (!zoomed && event.touches.length === 1) swipeStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }

  function handleTouchEnd(event: TouchEvent<HTMLDivElement>) {
    if (zoomed || !swipeStart.current || event.changedTouches.length !== 1) return;
    const start = swipeStart.current;
    swipeStart.current = null;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      const destination = dx < 0 ? next : previous;
      if (destination) onNavigate(destination);
    }
  }

  if (!file) return null;
  const unsupported = !IMAGE_MIMES.has(file.mime) && !(file.mime === "video/mp4" || file.mime === "video/webm") && !file.mime.startsWith("audio/") && !(file.mime.startsWith("text/") && file.size < 1_000_000);
  const visiblePreview = previewFileId === file.id ? preview : { status: "loading" as const };
  const description = `${formatBytes(file.size)} · ${typeName(file)}${dimensions ? ` · ${dimensions.width} × ${dimensions.height}` : ""}`;
  const isMediaLoading = !unsupported && (visiblePreview.status === "loading" || (visiblePreview.status === "ready" && (visiblePreview.kind === "image" || visiblePreview.kind === "video" || visiblePreview.kind === "audio") && !mediaReady));
  return <Dialog open={open} onOpenChange={value => !value && onClose()}>
    <DialogContent className="file-viewer-dialog sm:max-w-5xl">
      <div className="file-viewer-header"><DialogHeader><DialogTitle className="truncate pr-8">{file.name}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader><div className="file-viewer-header-actions"><span className="file-viewer-counter">{currentIndex + 1} of {files.length}</span><button className="btn btn-secondary file-viewer-action" onClick={() => onShare(file)}><Link size={16}/>Share</button></div></div>
      <div ref={stageRef} className={`file-viewer-stage ${zoomed ? "is-zoomed" : ""}`} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        {previous&&<button className="file-viewer-chevron file-viewer-chevron-left" aria-label="Previous file" onClick={() => onNavigate(previous)}><ChevronLeft/></button>}
        {next&&<button className="file-viewer-chevron file-viewer-chevron-right" aria-label="Next file" onClick={() => onNavigate(next)}><ChevronRight/></button>}
        {isMediaLoading&&<Loader2 className="loading-spinner file-viewer-spinner" aria-label="Loading preview"/>}
        {visiblePreview.status === "error"&&<div className="file-viewer-message" role="alert"><File size={42}/><p>{visiblePreview.message}</p><button className="btn btn-secondary" onClick={() => {setPreview({ status: "loading" });setPreviewFileId(file.id);setMediaReady(false);setDimensions(null);setCanZoom(false);setZoomed(false);setRetry(value => value + 1);}}><RotateCcw size={16}/>Retry</button></div>}
        {(visiblePreview.status === "empty"||unsupported)&&<div className="file-viewer-message"><File size={42}/><p>Download this file to open it in your preferred app.</p></div>}
        {visiblePreview.status === "ready"&&visiblePreview.kind === "image"&&<img key={file.id} ref={imageRef} className={`file-viewer-image ${zoomed ? "is-actual" : ""} ${canZoom ? (zoomed ? "can-zoom-out" : "can-zoom-in") : ""}`} src={visiblePreview.url} alt={file.name} onLoad={() => { setMediaReady(true); const image = imageRef.current; if (image) { setDimensions({ width: image.naturalWidth, height: image.naturalHeight }); setCanZoom(image.naturalWidth > image.clientWidth + 1 || image.naturalHeight > image.clientHeight + 1); } }} onError={() => setPreview({ status: "error", message: "This image preview could not be loaded." })} onClick={event => toggleZoom(event)}/>}
        {visiblePreview.status === "ready"&&visiblePreview.kind === "video"&&<video key={file.id} className="file-viewer-video" src={visiblePreview.url} controls onLoadedData={() => setMediaReady(true)} onError={() => setPreview({ status: "error", message: "This video preview could not be loaded." })}/>} 
        {visiblePreview.status === "ready"&&visiblePreview.kind === "audio"&&<audio key={file.id} className="file-viewer-audio" src={visiblePreview.url} controls onCanPlay={() => setMediaReady(true)} onError={() => setPreview({ status: "error", message: "This audio preview could not be loaded." })}/>} 
        {visiblePreview.status === "ready"&&visiblePreview.kind === "text"&&<pre className="file-viewer-text">{visiblePreview.text}</pre>}
      </div>
      <div className="file-viewer-footer"><span className="file-viewer-hint">{canZoom ? `Click image or press Z to ${zoomed ? "fit" : "zoom"}.` : ""}</span><button className="btn btn-primary" onClick={() => onDownload(file)}><ArrowDownToLine size={16}/>Download file</button></div>
    </DialogContent>
  </Dialog>;
}
