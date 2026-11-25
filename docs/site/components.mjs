const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const paths = {
  mac: '<rect x="3" y="4" width="26" height="18" rx="3"/><path d="M12 28h8m-4-6v6"/>',
  terminal: '<rect x="3" y="5" width="26" height="22" rx="4"/><path d="m9 12 4 4-4 4m8 0h6"/>',
  model: '<path d="m16 3 12 7v12l-12 7-12-7V10Z"/><path d="m4 10 12 7 12-7m-12 7v12M10 6.5l12 7"/>',
  text: '<path d="M19 3H8a3 3 0 0 0-3 3v20a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3V11Z"/><path d="M19 3v8h8M11 17h10m-10 5h10"/>',
  presentation:
    '<rect x="3" y="4" width="26" height="20" rx="3"/><path d="M16 24v5m-5 0h10M9 17l4-5 4 3 6-7"/>',
  blender:
    '<path d="m4 10 10 1-6-7m6 7-11 7h8"/><ellipse cx="20" cy="18" rx="10" ry="9"/><ellipse cx="20" cy="18" rx="5" ry="4"/>',
  freecad: '<path d="M5 28V4h19M5 15h13m3 3 8 4v7l-8-4-7 4v-7Z"/><path d="m14 22 7 4 8-4m-8 4v3"/>',
  file: '<path d="M19 3H8a3 3 0 0 0-3 3v20a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3V11Z"/><path d="M19 3v8h8M11 18h10m-10 5h7"/>',
  download: '<path d="M16 3v17m-6-6 6 6 6-6M5 22v4a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3v-4"/>'
};
const icon = (name) =>
  `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const arrow = '<span class="card-arrow" aria-hidden="true">↗</span>';

function home(html, en) {
  return html.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/, (_match, contents) => {
    const items = contents.replace(
      /<li>\s*<a ([^>]+)>([\s\S]*?)<\/a>\s*<\/li>/g,
      (_item, attributes, title) => {
        const kind = /README\.(?:zh-CN|md)/.test(attributes)
          ? "mac"
          : /development/.test(attributes)
            ? "terminal"
            : "text";
        const install = kind === "mac";
        const meta = install ? "macOS 14+ · Linux · Node.js 22.19+" : "";
        return `<li${install ? "" : ' class="entry-settings"'}><a ${attributes} class="entry-card ${install ? "entry-install" : "entry-route"}"><span class="entry-symbol">${icon(kind)}</span><strong>${title}</strong>${meta ? `<span class="entry-meta">${meta}</span>` : ""}${arrow}</a></li>`;
      }
    );
    return `<ul class="start-options entry-grid" aria-label="${en ? "Get started" : "开始使用"}">${items}</ul>`;
  });
}

// Source Markdown stays readable on GitHub. Enhance only the maintained user entry pages.
export function decorateArticle(page, html) {
  const file = page.file.replace(/^docs\/en\//, "docs/");
  if (file === "docs/README.md") return home(html, page.english);
  return html;
}
