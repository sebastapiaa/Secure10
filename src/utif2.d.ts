declare module "utif2" {
  interface Ifd {
    width: number;
    height: number;
    t282?: number[];
    t296?: number[];
  }
  const UTIF: {
    decode(buffer: ArrayBuffer): Ifd[];
    decodeImage(buffer: ArrayBuffer, ifd: Ifd): void;
    toRGBA8(ifd: Ifd): Uint8Array;
  };
  export default UTIF;
}
