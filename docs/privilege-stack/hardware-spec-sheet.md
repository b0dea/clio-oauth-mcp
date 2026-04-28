# Hardware Spec Sheet — Privilege Stack

April 2026 reference. Prices are approximate and may shift due to ongoing DRAM supply pressure (Apple eliminated the 512 GB Mac Studio option in March 2026; high-memory configs frequently out of stock).

---

## Tier 1 — Solo lawyer or small firm (1-3 attorneys)

**Recommended: Mac Studio M4 Max, 128 GB unified memory, 1 TB SSD**

- **Model fit:** Llama 4 70B Q4 fits with headroom. DeepSeek V4 Pro fits. GLM-5 fits.
- **Performance:** 10-15 tokens/sec on 70B Q4. Comparable to consumer Claude in feel.
- **Estimated cost:** $5,000-$7,000 (Apple direct). DRAM shortage may push higher.
- **Why this and not the M4 Max 64 GB:** at 64 GB you can run 70B but with very thin headroom for context. Long conversations or large document summaries hit memory pressure. 128 GB removes that constraint.
- **Why this and not the M3 Ultra:** M3 Ultra has higher memory bandwidth (good for inference) but starts at $3,999 with only 96 GB. You either pay more for less memory, or pay much more for the upgrade.

**Alternative: Mac Studio M3 Ultra, 96 GB minimum**

- **Estimated cost:** $3,999+
- **Performance:** 12-15 tokens/sec on 70B Q4 (slightly faster than M4 Max due to memory bandwidth)
- **Use this if:** the M4 Max 128 GB is out of stock or your budget is tighter
- **Don't use this for:** loading multiple large models in memory simultaneously

---

## Tier 2 — Firm with 5-15 attorneys, multi-user

**Recommended: Mac Studio M3 Ultra, 256 GB unified memory**

- **Model fit:** can hold Llama 4 70B + DeepSeek V4 + a smaller embedding model in memory simultaneously. Faster context switching between models.
- **Performance:** 12-15 tokens/sec on 70B Q4 per active session. Supports 2-3 concurrent users with reasonable response times.
- **Estimated cost:** $8,000-$12,000
- **Networking:** put it on the firm's LAN with appropriate firewall rules. Each attorney points their LM Studio at the shared instance.
- **Why this:** you're trading off raw GPU compute for unified memory headroom — exactly what 70B+ models need.

**Alternative: Linux server with NVIDIA RTX 5090 (32 GB VRAM)**

- **Estimated cost:** $5,000-$8,000 for the full system (CPU, 64 GB RAM, RTX 5090, NVMe)
- **Model fit:** 70B at Q4 needs partial CPU offload due to VRAM constraint. Slower than Mac Studio for unified memory workloads.
- **Performance:** 8-12 tokens/sec on 70B Q4 with offloading. Much faster on smaller models (GLM-5 30B, Llama 4 Scout) — 30+ tok/sec.
- **Use this if:** Mac Studio is unavailable, your firm already runs a Linux infrastructure, or you want flexibility to upgrade GPUs later.
- **Don't use this for:** primary 70B workloads if you have the budget for unified memory.

---

## Tier 3 — Multi-attorney firm wanting frontier-quality, multiple models live

**Recommended: Mac Studio M3 Ultra, 256 GB unified memory + secondary Mac Studio for redundancy**

- **Estimated cost:** $16,000-$24,000 for the pair
- **Why two:** one is primary inference, the second is a hot standby that takes over if the primary is busy or down. Mac Studios can also be daisy-chained for distributed inference using `mlx`.
- **Note:** at this scale, a managed Claude Enterprise + ZDR deployment may be more cost-effective than self-hosting. Consider whether absolute privilege is the priority or if Anthropic's contractual no-training is enough. See "When this stack isn't the right fit" in the main README.

---

## Network requirements

- **Outbound:** allow `app.clio.com` and the regional Clio endpoints (`eu.app.clio.com`, `ca.app.clio.com`). Block all other AI provider endpoints if you want to be belt-and-suspenders.
- **Inbound:** none required for solo/single-user deployment. For multi-user, the inference machine needs to listen on whatever port LM Studio's API is bound to (typically 1234) on the firm's LAN.
- **Bandwidth during normal use:** minimal. Initial model download is 40-60 GB per model. After that, only Clio API traffic (small JSON payloads).

---

## Storage requirements

| Item | Size |
|------|------|
| LM Studio app | ~500 MB |
| Llama 4 70B Q4 | ~40 GB |
| DeepSeek V4 Pro Q4 | ~50 GB |
| Llama 4 Scout (MoE) Q4 | ~60 GB (109B params total) |
| GLM-5 Q4 | ~50 GB |
| Audit log (long-term, append-only) | ~1 GB per year per attorney |
| OS + workspace | ~100 GB |
| **Recommended SSD** | **1 TB minimum** |

---

## Procurement notes

- **Apple Mac Studio:** order direct from [apple.com/shop/buy-mac/mac-studio](https://www.apple.com/shop/buy-mac/mac-studio). Configurable RAM. Lead time 2-4 weeks for high-memory configs as of April 2026.
- **NVIDIA RTX 5090:** retail price MSRP ~$1,999 but street price is higher and availability variable. Source from authorized retailers (Best Buy, Newegg, Microcenter) to avoid scalpers.
- **Linux server build:** if you want a turnkey Linux box, Lambda Labs and Puget Systems both build them. Expect 4-8 week lead times.

---

## What we don't recommend

- **Cloud GPU instances** (RunPod, vast.ai, AWS GPU, etc.) — defeats the privilege purpose by adding a third-party processor. The whole point of this stack is to eliminate that.
- **MacBook Pro with 64 GB** — runs hot, throttles after 5-10 minutes of sustained inference, battery + thermal management makes it unsuitable for daily heavy use.
- **AMD GPUs** — ROCm support for newer LLMs is improving but still lags CUDA. Mac (Metal) and NVIDIA (CUDA) are the smooth paths.
- **CPU-only inference** — possible but slow (1-3 tok/sec on 70B). Only acceptable for testing.

---

## Updated April 28, 2026

We update this spec sheet quarterly or when a major hardware shift happens. Open an issue at [github.com/oktopeak/clio-mcp/issues](https://github.com/oktopeak/clio-mcp/issues) if you spot anything stale.
