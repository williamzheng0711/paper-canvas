import { describe, expect, it, vi } from "vitest";
import { localAssetPath, localAssetUrl } from "./localAssets";

describe("local Markdown resource paths", () => {
  it("normalizes parent-relative paths before handing them to the native asset protocol", () => {
    const convert = vi.fn((path: string) => `asset://${path}`);
    expect(
      localAssetUrl(
        "/Users/example/test-fixtures/reading-demo",
        "../papercanvas-sample-image.svg",
        convert,
      ),
    ).toBe("asset:///Users/example/test-fixtures/papercanvas-sample-image.svg");
    expect(convert).toHaveBeenCalledWith(
      "/Users/example/test-fixtures/papercanvas-sample-image.svg",
    );
  });

  it.each([
    [
      "images/My%20figure.svg#view",
      "/Users/example/notes/images/My figure.svg",
      "#view",
    ],
    ["./images/../figure.png?v=2", "/Users/example/notes/figure.png", "?v=2"],
    ["/Users/example/figure.png", "/Users/example/figure.png", ""],
    [
      "file:///Users/example/My%20figure.png",
      "/Users/example/My figure.png",
      "",
    ],
    ["100%figure.png", "/Users/example/notes/100%figure.png", ""],
  ])(
    "resolves %s without treating URL suffixes as part of the filename",
    (source, path, suffix) => {
      expect(localAssetPath("/Users/example/notes", source)).toEqual({
        path,
        suffix,
      });
    },
  );

  it("normalizes Windows parent-relative and absolute image paths", () => {
    expect(
      localAssetPath("C:\\Users\\example\\notes", "..\\figure.png"),
    ).toEqual({ path: "C:\\Users\\example\\figure.png", suffix: "" });
    expect(
      localAssetPath("C:\\Users\\example\\notes", "D:\\images\\figure.png"),
    ).toEqual({ path: "D:\\images\\figure.png", suffix: "" });
  });
});
