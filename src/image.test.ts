import { expect, test } from "bun:test";
import { join } from "node:path";
import { imageInfo } from "./image";

const fixture = (name: string) => Bun.file(join(import.meta.dir, "testdata", name)).bytes();

test("PNG, JPEG and GIF headers give the type and size", async () => {
  expect(imageInfo(await fixture("3x2.png"))).toEqual({ mime: "image/png", width: 3, height: 2 });
  expect(imageInfo(await fixture("3x2.jpg"))).toEqual({ mime: "image/jpeg", width: 3, height: 2 });
  expect(imageInfo(await fixture("3x2.gif"))).toEqual({ mime: "image/gif", width: 3, height: 2 });
});

test("other or cut-off data is not an image", () => {
  expect(imageInfo(new TextEncoder().encode("RIFF....WEBP"))).toBeNull();
  expect(imageInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  expect(imageInfo(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
});
