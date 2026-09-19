# Jev continuation regression check

All live decisions used TypeSafe `jev-latest`, the same 87,776-word dictionary and complete saved Jev classifications. No other model generated, repaired or substituted an answer. The API key remained in process memory; this report contains only deliberately authored test prompts and aggregate observations.

## Reproduced regression

With the previous engine, beam 3, grammar review enabled, a 24-selection ceiling and a 140-request test ceiling:

- “Tell me about cats.” reached 140 requests without finishing. Its output began “They are a active often do playing much very energetic.”
- “How do I make a good cup of tea?” also reached 140 requests without finishing. Its output began “You need a water enough be got then…”

## Corrected continuation path

With restored prefix routing, direct context in questions, all shortlisted base candidates retained, and the independent grammar veto removed, the initial one-answer trials returned:

| Prompt | Actual Jev output | Requests | Observation |
| --- | --- | ---: | --- |
| Tell me about cats. | They are domesticated | 26 | Brief, relevant; Jev ended it. |
| How do I make a good cup of tea? | Boil water | 19 | Relevant first step, incomplete recipe. |
| Why is the sky blue? | Because the atmosphere is clear | 41 | Brief but scientifically inadequate. |

These were development trials, not a blinded or statistically powered evaluation. Models are stochastic and other wording can behave differently.

## Three short sentences

The requested reply style is now the default. Using beam 3, a 32-selection ceiling and a 200-request test ceiling:

| Prompt | Actual Jev output | Requests | Observation |
| --- | --- | ---: | --- |
| Tell me about cats. | Cats can climb. They can jump. They can't fly. | 81 | Three grammatical, relevant sentences; stopped at the third boundary. |
| How do I make a good cup of tea? | Make a tea. Water boil. | 55 | Jev ended early; grammar and usefulness remain weak. |

The sentence target is guidance, not a reason to force filler. The stop option stays available and the application also caps terminal sentence boundaries. A separate shortlist grammar-reranking probe did not reliably fix the weak case, so it was not added to the product.

## What this establishes

The all-candidate grammar veto no longer prevents ending, the 48-base-word truncation is removed, and the problematic range routing is reverted. The repeated budget-exhaustion regression was not reproduced in these corrected trials. Full dictionary/category coverage and the Jev-only path are covered by regression tests. This does **not** establish universally correct grammar, complete answers or factual reliability; those limitations remain visible in the examples above.
