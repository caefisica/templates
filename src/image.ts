// Reads an image's type and size from its header, for the three types both
// design tools take.

export type ImageInfo = { mime: string; width: number; height: number };

export function imageInfo(data: Uint8Array): ImageInfo | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50)
    return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49)
    return { mime: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (data[0] === 0xff && data[1] === 0xd8) return jpegInfo(view);
  return null;
}

// The size is in the first start-of-frame segment: markers C0 to CF, except
// C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding).
function jpegInfo(view: DataView): ImageInfo | null {
  let at = 2;
  while (at + 9 <= view.byteLength) {
    if (view.getUint8(at) !== 0xff) return null;
    const marker = view.getUint8(at + 1);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return {
        mime: "image/jpeg",
        width: view.getUint16(at + 7),
        height: view.getUint16(at + 5),
      };
    at += 2 + view.getUint16(at + 2);
  }
  return null;
}
