---
name: js-pages
description: What to do when a page is empty, a JavaScript app shell, or asks to enable JavaScript. Load when web_fetch returns little or no text.
---

# Pages that need JavaScript

`web_fetch` does not run JavaScript. Many developer portals and marketplaces render everything in the browser, so the fetch comes back almost empty.

Never stop or tell the developer "this is a JavaScript site, I can't read it". Instead:

1. Call `render_page` with the same URL. It opens the page in a real browser and returns the text.
2. If rendering fails or is turned off, try the vendor's docs on another path: `/docs`, `/developers`, `developer.<domain>`, `docs.<domain>`, or the API reference.
3. Search for the exact page title or topic plus the vendor name, and read a result that is plain HTML (a docs page, a changelog entry, a help center article).
4. As a last resort use the domain, page title and search snippets, and mark the claim "unverified".

Rendering is slower than fetching. Use it only for pages that matter to the guide.
