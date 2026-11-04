/// <reference lib="webworker" />
import UTIF from "utif2";
import { readDpi } from "./engine/metadata";
import { NoCardError, analyzeScan } from "./engine/pipeline";
import type { Measurement, Raster, CardSide } from "./engine/types";

export interface WorkerCard {
  crop: Blob;
  thumb: Blob;
  cropWidth: number;
  cropHeight: number;
  measurement: Measurement;
  side: CardSide;
  dpi: number;
  rotation: number;
  widthMm: number;
  heightMm: number;
  warnings: string[];
  needsReview: boolean;
}

export type WorkerReply = { id: number; cards: WorkerCard[]; error?: undefined } | { id: number; error: string; cards?: undefined };

/** Above this the page risks running out of memory. It's roughly a full 8.5x11 bed at 950 DPI. */
const MAX_PIXELS = 84_000_000;

function fromCanvasSource(source: ImageBitmap): Raster {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  // Transparent PNGs land on white, the same as a scanner lid.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, source.width, source.height);
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, source.width, source.height);
  return { width: image.width, height: image.height, data: image.data };
}

async function decode(file: File, buffer: ArrayBuffer): Promise<{ raster: Raster; dpi: number | null }> {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    throw new NoCardError("PDF scans aren't supported. Set your scanner to save as JPG, PNG or TIFF.");
  }
  if (file.type === "image/tiff" || name.endsWith(".tif") || name.endsWith(".tiff")) {
    const ifds = UTIF.decode(buffer);
    const page = ifds[0];
    UTIF.decodeImage(buffer, page);
    const rgba = UTIF.toRGBA8(page);
    const data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 255) continue;
      data[i] = (data[i] * a + 255 * (255 - a)) / 255;
      data[i + 1] = (data[i + 1] * a + 255 * (255 - a)) / 255;
      data[i + 2] = (data[i + 2] * a + 255 * (255 - a)) / 255;
      data[i + 3] = 255;
    }
    const res = page.t282 ? page.t282[0] : null;
    const unit = page.t296 ? page.t296[0] : 2;
    const dpi = res && res > 1 ? (unit === 3 ? res * 2.54 : res) : null;
    return { raster: { width: page.width, height: page.height, data }, dpi };
  }
  const blob = new Blob([buffer], { type: file.type });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new NoCardError(`Couldn't open ${file.name}. Use a JPG, PNG, WEBP or TIFF scan.`);
  }
  if (bitmap.width * bitmap.height > MAX_PIXELS) {
    const shrink = Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height));
    const large = bitmap;
    bitmap = await createImageBitmap(large, {
      resizeWidth: Math.floor(large.width * shrink),
      resizeHeight: Math.floor(large.height * shrink),
      resizeQuality: "high",
    });
    large.close();
  }
  const raster = fromCanvasSource(bitmap);
  bitmap.close();
  return { raster, dpi: readDpi(buffer) };
}

async function encode(crop: Raster): Promise<{ crop: Blob; thumb: Blob }> {
  const canvas = new OffscreenCanvas(crop.width, crop.height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(crop.data), crop.width, crop.height), 0, 0);
  const full = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
  const scale = 160 / crop.height;
  const small = new OffscreenCanvas(Math.round(crop.width * scale), 160);
  const smallCtx = small.getContext("2d")!;
  smallCtx.imageSmoothingQuality = "high";
  smallCtx.drawImage(canvas, 0, 0, small.width, small.height);
  const thumb = await small.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return { crop: full, thumb };
}

self.onmessage = async (event: MessageEvent<{ id: number; file: File }>) => {
  const { id, file } = event.data;
  try {
    const buffer = await file.arrayBuffer();
    const { raster, dpi } = await decode(file, buffer);
    const analyses = analyzeScan(raster, { metadataDpi: dpi });
    const cards: WorkerCard[] = [];
    for (const a of analyses) {
      const encoded = await encode(a.crop);
      if (analyses.length > 1) {
        a.warnings.push(`This scan held ${analyses.length} cards. Each one was saved as its own entry.`);
      }
      cards.push({
        crop: encoded.crop,
        thumb: encoded.thumb,
        cropWidth: a.crop.width,
        cropHeight: a.crop.height,
        measurement: a.measurement,
        side: a.side,
        dpi: a.dpi,
        rotation: a.rotation,
        widthMm: a.widthMm,
        heightMm: a.heightMm,
        warnings: a.warnings,
        needsReview: a.needsReview,
      });
    }
    (self as unknown as Worker).postMessage({ id, cards } satisfies WorkerReply);
  } catch (err) {
    const message = err instanceof NoCardError ? err.message : `Couldn't process ${file.name}: ${err instanceof Error ? err.message : "unknown error"}`;
    (self as unknown as Worker).postMessage({ id, error: message } satisfies WorkerReply);
  }
};
