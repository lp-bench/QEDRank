# Candidate models: availability and prices (checked 8 Oct 2026)

Web check by Claude's research agent; vendor list prices, USD per million tokens
(input / output). "Retired" = no longer callable on the vendor's own API.
Historic prices of retired models are from launch announcements, not re-verified.

| Model | Released | API status Oct 2026 | $/M in / out | Open weights | Tools |
|---|---|---|---|---|---|
| Claude 3.7 Sonnet | 24 Feb 2025 | Retired 19 Feb 2026 | was 3 / 15 | No | Yes |
| Claude Opus 4 | 22 May 2025 | Retired 15 Jun 2026 (still on Google Cloud Vertex) | was 15 / 75 | No | Yes |
| Claude Opus 4.5 | 24 Nov 2025 | Active, not retired before 24 Nov 2026 | 5 / 25 | No | Yes |
| Claude Opus 4.6 | 5 Feb 2026 | Active, not before 5 Feb 2027 | 5 / 25 | No | Yes |
| Claude Opus 5.5 | 22 Sep 2026 | Active | 4 / 20 | No | Yes |
| Claude Fable 5.1 | 1 Sep 2026 | Active | 10 / 50 | No | Yes |
| OpenAI o3 | 16 Apr 2025 | Deprecated, shutdown 11 Dec 2026 | 2 / 8 | No | Yes |
| GPT-5 | 7 Aug 2025 | Deprecated, shutdown 11 Dec 2026 | 1.25 / 10 | No | Yes |
| GPT-5.2 | 11 Dec 2025 | Listed, no shutdown announced (at risk) | 1.75 / 14 | No | Yes |
| GPT-6 Astra | 3 Sep 2026 | Active (frontier) | 10 / 50 | No | Yes |
| GPT-6.1 Sol | 29 Sep 2026 | Active | 2 / 10 | No | Yes |
| Gemini 2.5 Pro | 17 Jun 2025 GA | Only for projects that used it before | 1.25 / 10 | No | Yes |
| Gemini 3 Pro | 18 Nov 2025 (preview) | Shut down 9 Mar 2026 | n/a | No | Yes |
| Gemini 3.1 Pro Preview | 19 Feb 2026 | Active (preview) | 2 / 12 | No | Yes |
| Gemini 3.8 Flash | 2 Sep 2026 | Active | 0.75 / 3.75 (intro) | No | Yes |
| DeepSeek R1 | 20 Jan 2025 | Retired from vendor API 24 Jul 2026; third-party hosts | was 0.55 / 2.19 | Yes (MIT) | R1-0528 only |
| DeepSeek V4-Pro | 13 Aug 2026 GA | Active | 0.66-1.32 / 1.98-3.96 | Yes (MIT) | Yes |
| Kimi K2 | 11 Jul 2025 | Retired 25 May 2026 | was 0.60 / 2.50 | Yes | Yes |
| Kimi K2 Thinking | 6 Nov 2025 | Retired 25 May 2026 | was 0.60 / 2.50 | Yes | Yes |
| Kimi K2.5 | 27 Jan 2026 | Retired 31 Aug 2026 | was 0.60 / 2.50-3.00 | Yes (MIT) | Yes |
| Kimi K3 | 16 Jul 2026 | Active | 3 / 15 | Yes (custom licence) | Yes |
| Qwen3-235B-A22B | 29 Apr 2025 | Listed on Model Studio (retirement unverified) | 0.70 / 2.80 | Yes (Apache 2.0) | Yes |
| Qwen3.5-397B-A17B | 16 Feb 2026 | Listed on Model Studio | 0.60 / 3.60 | Yes (Apache 2.0) | Yes |
| Qwen3.8-Max | 3 Aug 2026 | Active | 2 / 6 | Text checkpoint, custom licence | Yes |

Consequences for the ten-model plan:
- Closed models older than about a year are gone from their vendors' APIs; the
  2025 points of the curve must come from open-weight models (self-hosted or via
  OpenRouter/Fireworks/DeepInfra), or from Opus 4 on Vertex. Run the 2025 open
  models early, before third-party hosts drop them too.
- Deadlines: o3 and GPT-5 shut down 11 Dec 2026; run them before.
- Original DeepSeek R1 has no function calling: use R1-0528.
- Claude 4.7+ tokenizers count about 30% more tokens per text than earlier ones:
  compare budgets in words or characters, not only tokens.

Sources: vendor deprecation and pricing pages (Anthropic, OpenAI, Google, DeepSeek,
Moonshot, Alibaba Model Studio), 8 Oct 2026.
