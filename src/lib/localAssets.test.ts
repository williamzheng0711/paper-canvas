import { describe, expect, it, vi } from "vitest";
import { encodeLocalAssetPath, localAssetPath, localAssetUrl } from "./localAssets";

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

  it.each([
    ["\\\\server\\share", "..\\image.png", "\\\\server\\share\\image.png"],
    ["\\\\server\\share\\notes", "..\\..\\..\\image.png", "\\\\server\\share\\image.png"],
    ["\\\\server\\share\\notes", "../images/My%20figure.png#view", "\\\\server\\share\\images\\My figure.png"],
    ["D:\\notes", "\\image.png", "D:\\image.png"],
    ["D:\\notes", "/../image.png", "D:\\image.png"],
    ["\\\\server\\share\\notes", "\\image.png", "\\\\server\\share\\image.png"],
    ["\\\\server\\share\\notes", "/../image.png", "\\\\server\\share\\image.png"],
    ["D:\\notes", "\\\\other\\share\\..\\image.png", "\\\\other\\share\\image.png"],
    ["\\\\server\\share\\notes", "//other/share/images/../image.png", "\\\\other\\share\\image.png"],
    ["\\\\server\\share\\notes", "E:/images/image.png", "E:\\images\\image.png"],
  ])("preserves Windows drive and network share roots for %s + %s", (base, source, path) => {
    expect(localAssetPath(base, source)).toEqual({ path, suffix: source.includes("#") ? "#view" : "" });
  });

  it("retains literal backslashes in POSIX directory and image names", () => {
    expect(localAssetPath("/notes/Folder\\", "image%5Cname.png")).toEqual({ path: "/notes/Folder\\/image\\name.png", suffix: "" });
    expect(localAssetPath("/notes", "%5Cleading.png")).toEqual({ path: "/notes/\\leading.png", suffix: "" });
    expect(encodeLocalAssetPath("back\\slash.assets/image.png", false)).toBe("back%5Cslash.assets/image.png");
    expect(encodeLocalAssetPath("C:\\notes\\image.png")).toBe("C:/notes/image.png");
  });

  it("treats a POSIX directory named like a Windows drive as an ordinary directory", () => {
    expect(localAssetPath("/notes/C:", "../image.png")).toEqual({ path: "/notes/image.png", suffix: "" });
    expect(localAssetPath("C:\\", "..\\image.png")).toEqual({ path: "C:\\image.png", suffix: "" });
    expect(encodeLocalAssetPath("C:/image.png", false)).toBe("C%3A/image.png");
  });
});
