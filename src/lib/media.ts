import { ApiError, authJson } from "./auth";

export type Purpose = "BADGE" | "INCIDENT";

export interface Processed {
  blob: Blob;
  width: number;
  height: number;
  sha256: string;
}

const env = import.meta.env as unknown as Record<string, string | undefined>;
const SUPABASE_URL = env.VITE_SUPABASE_URL ?? "";
const SUPABASE_KEY = env.VITE_SUPABASE_ANON_KEY ?? "";
const SUPABASE_BUCKET = env.VITE_SUPABASE_BUCKET ?? "lumon-media";
const CLOUD_NAME = env.VITE_CLOUDINARY_CLOUD_NAME ?? "";
const UPLOAD_PRESET = env.VITE_CLOUDINARY_UPLOAD_PRESET ?? "";

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Codifica el canvas en WebP bajando la calidad hasta entrar en el peso maximo. Sin metadatos. */
export async function canvasToWebp(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob> {
  for (const q of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", q));
    if (!blob || blob.type !== "image/webp") {
      throw new Error("Tu navegador no puede generar imágenes WebP. Prueba con Chrome, Edge o Firefox.");
    }
    if (blob.size <= maxBytes) return blob;
  }
  throw new Error("No se pudo reducir la imagen al peso máximo permitido.");
}

export function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("El archivo no es una imagen válida."));
    };
    img.src = url;
  });
}

/** INCIDENT: lado mayor entre 800 y 1600, WebP, <= 300 KB. */
export async function processIncident(file: Blob): Promise<Processed> {
  const img = await loadImage(file);
  const longSide = Math.max(img.naturalWidth, img.naturalHeight);
  const target = Math.min(1600, Math.max(800, longSide));
  const scale = target / longSide;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas no disponible");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToWebp(canvas, 300 * 1024);
  return { blob, width: canvas.width, height: canvas.height, sha256: await sha256Hex(blob) };
}

export interface Ticket {
  ticketId: string;
  path: string;
  raw: Record<string, unknown>;
}

export async function requestTicket(purpose: Purpose, p: Processed): Promise<Ticket> {
  const raw = await authJson<Record<string, unknown>>("/media/tickets", {
    method: "POST",
    body: JSON.stringify({ purpose, bytes: p.blob.size, width: p.width, height: p.height, sha256: p.sha256 }),
  });
  const ticketId = String(raw.ticketId ?? raw.id ?? "");
  const path = String(raw.path ?? raw.objectPath ?? raw.key ?? raw.publicId ?? raw.uploadPath ?? "");
  if (!ticketId || !path) throw new Error("La respuesta del ticket no trae la ruta de subida.");
  return { ticketId, path, raw };
}

export interface UploadHandle {
  promise: Promise<string>;
  abort: () => void;
}

/** Sube a SU storage con XMLHttpRequest para tener progreso real. Devuelve la URL publica. */
export function uploadToStorage(blob: Blob, path: string, onProgress: (pct: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<string>((resolve, reject) => {
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => reject(new Error("Falló la subida (red)."));
    xhr.onabort = () => reject(new DOMException("Subida cancelada", "AbortError"));
    if (CLOUD_NAME) {
      const publicId = path.replace(/\.webp$/, "");
      const form = new FormData();
      form.append("file", blob);
      form.append("upload_preset", UPLOAD_PRESET);
      form.append("public_id", publicId);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const json = JSON.parse(xhr.responseText) as { secure_url?: string };
          resolve(json.secure_url ?? "");
        } else reject(new Error(`El storage rechazó la imagen (HTTP ${xhr.status}).`));
      };
      xhr.open("POST", `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`);
      xhr.send(form);
      return;
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      reject(new Error("Falta configurar el storage (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)."));
      return;
    }
    const clean = path.replace(/^\/+/, "").replace(new RegExp(`^${SUPABASE_BUCKET}/`), "");
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(`${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${clean}`);
      } else reject(new Error(`El storage rechazó la imagen (HTTP ${xhr.status}).`));
    };
    xhr.open("POST", `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${clean}`);
    xhr.setRequestHeader("Authorization", `Bearer ${SUPABASE_KEY}`);
    xhr.setRequestHeader("apikey", SUPABASE_KEY);
    xhr.setRequestHeader("Content-Type", "image/webp");
    xhr.setRequestHeader("x-upsert", "false");
    xhr.send(blob);
  });
  return { promise, abort: () => xhr.abort() };
}

export async function confirmTicket(ticketId: string, url: string): Promise<string> {
  const raw = await authJson<Record<string, unknown>>(`/media/tickets/${ticketId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  const mediaId = raw.mediaId ?? raw.id;
  if (mediaId === undefined || mediaId === null) throw new Error("La confirmación no devolvió mediaId.");
  return String(mediaId);
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.details as Record<string, unknown> | null;
    const reason = d && typeof d.reason === "string" ? `: ${d.reason}` : "";
    return `${e.code}${reason} — ${e.message}`;
  }
  return e instanceof Error ? e.message : "Error inesperado";
}
