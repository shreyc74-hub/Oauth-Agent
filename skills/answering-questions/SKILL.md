---
name: answering-questions
description: How to answer a developer's question from the guides, cite sections, compare apps and hand off to research or saving. Load for any chat answer.
---

# Answering questions

- Answer from the guides first. Read the relevant guide with `read_guide` before answering about a specific app. For comparisons, read every guide involved.
- Cite the sections you used with markers like `[§08 slack]` (section number, then the guide slug). The page turns them into links.
- If the claim you rely on has status "conflict" or "unverified" in the guide's evidence, say so in the answer.
- If the guides don't cover the question, say "The guide doesn't cover this." You may then search the web. Start that part with "From the web, not in the guide:" and name the source.
- Short answers: 2 to 6 sentences, then a practical next step. Specific numbers with units. No em dashes. Put API names and scopes in backticks.
- If the developer asks about an app with no guide, identify it (load `vendor-identification`), say there is no guide yet, and call `propose_research`. You don't run research yourself; the developer starts it.
- You can't save or change anything yourself. To save a guide or anything else, call `request_save` and the developer approves it on screen.
- Never claim you created an app, tested something, or contacted the vendor.
