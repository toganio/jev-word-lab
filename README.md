# Jev Word Lab

An English dictionary-constrained conversation experiment using TypeSafe AI's `jev-latest` and `POST https://api.typesafe.ai/v1/systemone`.

## Start

Node 22.13+ is required. Run `npm install`, then `npm run dev`. Enter your TypeSafe API key in the password field and click **Bağlan**. A single real choice request verifies access. Keys live only in the browser component's memory and are forwarded over the same-origin backend to TypeSafe. They are not saved, logged, or included in exports. Do not put a shared key in client code.

Choose the full dictionary or a smaller frequency-ranked subset, retained path count, output limit, and API request budget. Click **Denemeyi başlat**. Every displayed decision is a real API response. Missing/invalid keys never generate mock answers.

## Dictionary and grouping

`public/data/words.txt` is the downloadable flat list. `dictionary.json` indexes the same words by Princeton WordNet 3.0 lexical categories, with closed-class function words and exception-table inflections added. WordNet's tagged usage counts determine ordering, not a modern conversation corpus. The source archive is available from https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip. Rebuild with `python3 scripts/build-dictionary.py /path/to/wordnet.zip`. The original license is included in `public/data/WORDNET-LICENSE.txt`.

The browser downloads the dictionary once per page load and indexes it in memory. Each category is split recursively by word prefix until groups contain at most 200 words. Jev scores category and subgroup choices; a configurable beam keeps multiple paths. Conditional path probabilities are multiplied before pruning. Top words from leaf groups and common function words are compared again in one final choice. Punctuation and an explicit stop action are available. All choice calls stay under the 255-option limit. Final probabilities are conditional on the finalists, not probabilities over the entire dictionary.

The **Sözlük** tab can additionally ask Jev to classify the next 240, 960, or 4,800 unclassified content words. Completed classifications override the starter taxonomy for future runs in this page session. These are real API calls; partial results survive cancellation and are included in the JSON export. The default usable taxonomy is from WordNet, not falsely attributed to Jev.

## Bounds and observability

The browser can cancel any experiment, caps API calls, records usage, stops repeated three-word loops, and preserves partial output. Each question passes the conversation's last ten messages and the current reply. The server validates all choice options and returned probability distributions, enforces payload limits, checks browser origin, fixes the upstream endpoint/model, and uses a 25-second timeout. API keys are never returned. A private hosted deployment is recommended; no server-owned key is included.

Multiple questions within one request are independent. Dependent tree levels and successive words use separate calls. With wide beams and large dictionaries this is a research experiment, not a guarantee of fluent chat. No second generative model is used.

WebMCP (where supported) exposes read experiment, stage question (no paid call), and stop actions. API keys are excluded.

## Jev-only enforcement and split monitor

The backend has one hard-coded upstream (`api.typesafe.ai/v1/systemone`) and always sends `model: jev-latest`. Model overrides are ignored and responses identifying a non-Jev model are rejected. There is no fallback model, generated mock reply, or assistant-authored completion. WordNet supplies initial dictionary categories; all AI decisions are from Jev. API errors stop the experiment and preserve partial output.

The left pane shows the conversation. The right **Canlı işlemler** pane logs each API request with time, selected category/word, question and option counts, duration, and success/error/cancellation. **Kelime izi** exposes finalist probabilities and tree traces. Exports include the operation journal without credentials.

## Validation

The production build, TypeScript checks, and nine offline tests pass. Tests cover full dictionary reachability, branching limits, cross-category final comparison, cancellation, response validation, batch classification, request origin/key handling, and rejection of other models. Test doubles are confined to `tests/`; the application does not offer a simulated model mode. Live Jev behavior requires the user's key and has not been asserted from offline tests. WebMCP tools were not exercised in a supporting browser context; ordinary UI does not depend on that experimental API.
