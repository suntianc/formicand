import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

/**
 * The icon and title behind a web link in a message.
 *
 * Each address is fetched once and what was read is kept under the user's data
 * home, so later renders and restarts read the file instead of the network.
 * Only public http(s) addresses are fetched: an address that names or resolves
 * to this machine or a private network is refused, at every redirect.
 */
export interface LinkPreview {
  url: string;
  title: string;
  /** The site icon as a `data:` URL, or empty when the site has none we can read. */
  icon: string;
}

export interface LinkPreviewService {
  preview(url: string): Promise<LinkPreview>;
}

interface Stored extends LinkPreview {
  fetchedAt: number;
}

const READ_TTL = 7 * 24 * 60 * 60 * 1000;
// A site that could not be read is asked again sooner.
const MISS_TTL = 24 * 60 * 60 * 1000;
const PAGE_BYTES = 512 * 1024;
const ICON_BYTES = 64 * 1024;
const TIMEOUT = 6_000;
const REDIRECTS = 3;

export class LinkPreviewRefused extends Error {}

function privateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) return privateAddress(value.slice(7));
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe8") ||
      value.startsWith("fe9") ||
      value.startsWith("fea") ||
      value.startsWith("feb") ||
      value.startsWith("ff")
    );
  }
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Refuses anything but a public http(s) address. */
async function assertPublic(url: URL, localAllowed: boolean): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new LinkPreviewRefused("只读取 http(s) 链接");
  if (url.username || url.password) throw new LinkPreviewRefused("链接带有登录信息");
  if (localAllowed) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
    throw new LinkPreviewRefused("不读取本机地址");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(privateAddress)) throw new LinkPreviewRefused("不读取内网地址");
}

/** Fetches `url`, following at most a few redirects, each checked again. */
async function fetchPublic(
  url: URL,
  accept: string,
  localAllowed: boolean
): Promise<{ response: Response; url: URL }> {
  let current = url;
  for (let hop = 0; hop <= REDIRECTS; hop += 1) {
    await assertPublic(current, localAllowed);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { accept, "user-agent": "Mozilla/5.0 (compatible; Formicand link preview)" }
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      current = new URL(location, current);
      continue;
    }
    return { response, url: current };
  }
  throw new LinkPreviewRefused("跳转次数过多");
}

/** At most `limit` bytes of the body; the rest is not downloaded. */
async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.byteLength;
    if (size >= limit) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (match, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  // Exactly one of the quoted, single-quoted or bare value groups matched.
  return match ? decodeEntities(match[2] || match[3] || match[4] || "") : undefined;
}

/** The page's title and the icon it declares, read from its HTML head. */
export function readHead(html: string): { title: string; icon?: string } {
  const end = html.search(/<\/head>/i);
  const head = end >= 0 ? html.slice(0, end) : html;
  let title = "";
  let icon: string | undefined;
  let iconRank = -1;
  for (const tag of head.match(/<(meta|link)\b[^>]*>/gi) ?? []) {
    if (/^<meta/i.test(tag)) {
      const key = (attribute(tag, "property") ?? attribute(tag, "name") ?? "").toLowerCase();
      if (!title && (key === "og:title" || key === "twitter:title")) title = attribute(tag, "content") ?? "";
      continue;
    }
    const rel = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const href = attribute(tag, "href");
    if (!href || !rel.some((value) => value === "icon" || value === "apple-touch-icon")) continue;
    // A scalable icon draws sharpest at 14px; otherwise the smallest declared size above it.
    const sizes = attribute(tag, "sizes") ?? "";
    const size = Number(/(\d+)x\d+/.exec(sizes)?.[1] ?? 0);
    const rank =
      /\.svg(\?|$)/i.test(href) || /svg/i.test(attribute(tag, "type") ?? "")
        ? 3
        : size >= 32 && size <= 64
          ? 2
          : rel.includes("icon")
            ? 1
            : 0;
    if (rank > iconRank) {
      icon = href;
      iconRank = rank;
    }
  }
  if (!title) title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "");
  return { title: title.replace(/\s+/g, " ").trim().slice(0, 200), icon };
}

async function readIcon(url: URL, localAllowed: boolean): Promise<string> {
  const { response } = await fetchPublic(url, "image/*", localAllowed);
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!response.ok || !type.startsWith("image/")) {
    await response.body?.cancel();
    return "";
  }
  const bytes = await readLimited(response, ICON_BYTES + 1);
  if (!bytes.length || bytes.length > ICON_BYTES) return "";
  return `data:${type};base64,${bytes.toString("base64")}`;
}

async function readPreview(url: URL, localAllowed: boolean): Promise<LinkPreview> {
  const page = await fetchPublic(url, "text/html,application/xhtml+xml", localAllowed);
  const type = page.response.headers.get("content-type") ?? "";
  let head: { title: string; icon?: string } = { title: "" };
  if (/html/i.test(type)) {
    head = readHead((await readLimited(page.response, PAGE_BYTES)).toString("utf8"));
    // An error page still names the site's icon, but its title is not the page's.
    if (!page.response.ok) head.title = "";
  } else await page.response.body?.cancel();
  let icon = "";
  for (const candidate of [head.icon, "/favicon.ico"]) {
    if (!candidate) continue;
    try {
      icon = await readIcon(new URL(candidate, page.url), localAllowed);
      // eslint-disable-next-line no-restricted-syntax -- 站点图标读不到时改试下一个候选，最后显示地球图标
    } catch {
      icon = "";
    }
    if (icon) break;
  }
  return { url: url.href, title: head.title, icon };
}

export function createLinkPreviewService({
  cacheRoot,
  localAllowed = false
}: {
  cacheRoot: string;
  /** Tests serve pages from this machine; the product never reads local addresses. */
  localAllowed?: boolean;
}): LinkPreviewService {
  const reading = new Map<string, Promise<LinkPreview>>();
  const fileFor = (url: string) => join(cacheRoot, `${createHash("sha256").update(url).digest("hex")}.json`);

  async function stored(url: string): Promise<Stored | undefined> {
    try {
      const value = JSON.parse(await readFile(fileFor(url), "utf8")) as Stored;
      const ttl = value.title || value.icon ? READ_TTL : MISS_TTL;
      return value.url === url && Date.now() - value.fetchedAt < ttl ? value : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // A damaged cache file is read again from the site.
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async function store(value: Stored): Promise<void> {
    await mkdir(cacheRoot, { recursive: true });
    const target = fileFor(value.url);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, target);
  }

  async function read(url: URL): Promise<LinkPreview> {
    const cached = await stored(url.href);
    if (cached) return { url: cached.url, title: cached.title, icon: cached.icon };
    let preview: LinkPreview;
    try {
      preview = await readPreview(url, localAllowed);
    } catch (error) {
      if (error instanceof LinkPreviewRefused) throw error;
      // The site did not answer in time or could not be read: remember the miss for a day.
      preview = { url: url.href, title: "", icon: "" };
    }
    await store({ ...preview, fetchedAt: Date.now() });
    return preview;
  }

  return {
    async preview(address) {
      let url: URL;
      try {
        url = new URL(address);
      } catch {
        throw new LinkPreviewRefused("链接不是合法地址");
      }
      url.hash = "";
      const key = url.href;
      const pending = reading.get(key);
      if (pending) return pending;
      const next = read(url).finally(() => reading.delete(key));
      reading.set(key, next);
      return next;
    }
  };
}
