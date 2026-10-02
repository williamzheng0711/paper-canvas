/** Encode a physical path as a Markdown destination without changing separators. */
export function encodeLocalAssetPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized
    .split("/")
    .map((segment, index) =>
      index === 0 && /^[A-Za-z]:\//.test(normalized)
        ? segment
        : encodeURIComponent(segment).replace(
            /[!'()*]/g,
            (character) =>
              `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
    )
    .join("/");
}

/** Resolve Markdown image URLs to canonical local paths before Tauri encodes them. */
export function localAssetPath(
  basePath: string,
  source: string,
): { path: string; suffix: string } {
  const suffixIndex = source.search(/[?#]/);
  let path = suffixIndex < 0 ? source : source.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? "" : source.slice(suffixIndex);
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = url.pathname;
      if (url.hostname && url.hostname !== "localhost")
        path = `//${url.hostname}${path}`;
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    } catch {
      // A malformed resource URL must not prevent the document from opening.
    }
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // A literal percent in a filesystem name need not be valid URI encoding.
  }
  const windows = basePath.includes("\\") || /^[A-Za-z]:[\\/]/.test(path);
  path = path.replace(/\\/g, "/");
  let base = basePath.replace(/\\/g, "/");
  const absolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path);
  if (!absolute) path = `${base.replace(/\/$/, "")}/${path}`;
  const prefix = path.startsWith("//") ? "//" : path.startsWith("/") ? "/" : "";
  const segments: string[] = [];
  for (const segment of path.slice(prefix.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (
      segment === ".." &&
      segments.length &&
      segments.at(-1) !== ".." &&
      !/^[A-Za-z]:$/.test(segments.at(-1)!)
    )
      segments.pop();
    else if (
      segment === ".." &&
      !prefix &&
      !/^[A-Za-z]:$/.test(segments.at(-1) ?? "")
    )
      segments.push(segment);
    else if (segment !== "..") segments.push(segment);
  }
  base = prefix + segments.join("/");
  return { path: windows ? base.replace(/\//g, "\\") : base, suffix };
}

export function localAssetUrl(
  basePath: string,
  source: string,
  convertFile: (path: string) => string,
): string {
  const { path, suffix } = localAssetPath(basePath, source);
  return `${convertFile(path)}${suffix}`;
}
