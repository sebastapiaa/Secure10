/** Reads the resolution stored in a JPEG or PNG. Returns null if the file doesn't state one. */
export function readDpi(buffer: ArrayBuffer): number | null {
  const v = new DataView(buffer);
  if (v.byteLength < 24) return null;
  if (v.getUint16(0) === 0xffd8) return readJpegDpi(v);
  if (v.getUint32(0) === 0x89504e47) return readPngDpi(v);
  return null;
}

function readJpegDpi(v: DataView): number | null {
  let p = 2;
  while (p + 9 < v.byteLength) {
    if (v.getUint8(p) !== 0xff) return null;
    const marker = v.getUint8(p + 1);
    const size = v.getUint16(p + 2);
    if (marker === 0xe0 && v.getUint32(p + 4) === 0x4a464946) {
      const units = v.getUint8(p + 11);
      const density = v.getUint16(p + 12);
      if (units === 1 && density > 1) return density;
      if (units === 2 && density > 1) return density * 2.54;
    }
    if (marker === 0xe1 && v.getUint32(p + 4) === 0x45786966) {
      const dpi = readExifDpi(v, p + 10);
      if (dpi) return dpi;
    }
    if (marker === 0xda) return null;
    p += 2 + size;
  }
  return null;
}

function readExifDpi(v: DataView, tiff: number): number | null {
  const little = v.getUint16(tiff) === 0x4949;
  const ifd = tiff + v.getUint32(tiff + 4, little);
  if (ifd + 2 > v.byteLength) return null;
  const entries = v.getUint16(ifd, little);
  let xRes: number | null = null;
  let unit = 2;
  for (let i = 0; i < entries; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > v.byteLength) return null;
    const tag = v.getUint16(e, little);
    if (tag === 0x011a) {
      const at = tiff + v.getUint32(e + 8, little);
      if (at + 8 > v.byteLength) return null;
      const denominator = v.getUint32(at + 4, little);
      if (denominator) xRes = v.getUint32(at, little) / denominator;
    }
    if (tag === 0x0128) unit = v.getUint16(e + 8, little);
  }
  if (!xRes || xRes <= 1) return null;
  return unit === 3 ? xRes * 2.54 : xRes;
}

function readPngDpi(v: DataView): number | null {
  let p = 8;
  while (p + 12 <= v.byteLength) {
    const length = v.getUint32(p);
    const type = v.getUint32(p + 4);
    if (type === 0x70485973) {
      const perMeter = v.getUint32(p + 8);
      return v.getUint8(p + 16) === 1 && perMeter > 0 ? perMeter * 0.0254 : null;
    }
    if (type === 0x49444154) return null;
    p += 12 + length;
  }
  return null;
}
