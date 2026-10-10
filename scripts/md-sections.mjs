// One owner for splitting a markdown file into its `##` sections and for the heading slug that names
// one. Fence-aware: a heading-shaped line inside a fenced block is content. A section runs from its
// `##` heading to the next `#` or `##` heading outside a fence, or the end of the file, so its `###`
// subsections belong to it.
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

// GitHub-style heading slug: lowercase, drop non-word (keep spaces/hyphens), spaces -> hyphens.
export const slug = (heading) => heading.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

export function sections(text) {
  const out = [];
  let fenced = false;
  let offset = 0;
  let open = null;
  const close = (end) => {
    if (open) out.push({ heading: open.heading, slug: open.slug, text: text.slice(open.start, end) });
    open = null;
  };
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) {
      const h = HEADING.exec(line);
      if (h && h[1].length <= 2) {
        close(offset);
        if (h[1].length === 2) open = { heading: h[2], slug: slug(h[2]), start: offset };
      }
    }
    offset += line.length + 1;
  }
  close(text.length);
  return out;
}

export const sectionText = (text, wanted) => sections(text).find((s) => s.slug === wanted)?.text ?? null;
