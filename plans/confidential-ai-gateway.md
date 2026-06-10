# Confidential AI Gateway — deeply personal AI for everyone, with *verifiable* absolute privacy

**Status:** Research synthesis + architecture sketch (2026-06-09). No code yet. Distills a working session on Phala/RedPill TEE inference into the design for the privacy layer that sits under the OS.
**Companion docs:** `dynamic-provider-substrate.md` (the `provider.call` gateway primitive — this extends the same "OS owns the last hop" idea to *model inference*), `session-tape-and-daydreaming.md` (the passive tape + memory = the "deeply personal" corpus this layer must keep private), `guardian-angel-blitzos.md` + `agent-os-dynamic-architecture.md` (the always-on personal brain that runs *against* this gateway).
**Empirical basis:** live pulls of `api.redpill.ai/v1/models` and `openrouter.ai/api/v1/models` + Phala/Anthropic/BleepingComputer docs, 2026-06-08. **Prices and attack-state drift — re-pull before quoting.**

---

## 0. The verdict up front

The product goal — *deeply personal AI, available to everyone, through our own gateway, with absolute privacy* — has exactly **one architecture that is not a lie**, and it follows from a single hard result:

> **You can only guarantee privacy for a model whose weights run inside a TEE you (or the user) can attest. Any model you reach by *proxying* to a third party (Claude, GPT-4, Gemini) exposes plaintext to that third party — no matter how good your own gateway's TEE is. A proxy can prove *it* didn't peek; it can never prove the *endpoint* didn't.**

Therefore the privacy promise is achievable **only** on **open-weight models served from a confidential GPU TEE**, and the gateway must be built so that **neither we (the operator), nor the infra host, nor a co-tenant can see prompts, the personal corpus, or responses — and the user can cryptographically verify that**. That last clause is the whole product. "Trust us" is not absolute privacy; "here is the attestation, verify it yourself" is.

Concretely: the only honest configuration is **control the inference enclave ourselves (own dstack deployment on a GPU TEE) and end-to-end-encrypt from the user's device into that enclave**, so our gateway is a *blind ciphertext router*. A plain gateway in front of an aggregator (RedPill) is convenient but **does not** deliver "we cannot see it," because either our gateway or the aggregator terminates plaintext. Pick the strong form, or stop calling it absolute.

---

## 1. The shape in one paragraph

A user's device (BlitzOS) holds the keys to that user's **personal corpus** (the session tape, memory, RAG index from `session-tape-and-daydreaming.md`), which lives **encrypted at rest** in our storage. To run inference, the device fetches the **attestation + public key of our inference enclave**, verifies the measurement against an allow-list it trusts, encrypts `{prompt + a capability to the user's corpus}` to that enclave's key, and ships the ciphertext through **our gateway**, which can only see *routing metadata* (which model, token counts, timing) — never content. Inside the enclave: decrypt prompt → present attestation to the **KMS** to obtain the user's **corpus data-key** → pull + decrypt the user's corpus *in-enclave* → do RAG + inference on an **open-weight model loaded inside the same TEE** → encrypt the response back to the device. Nobody outside the enclave — including us — ever sees plaintext. "For everyone" = the enclave is multi-tenant but per-user keyed; "deeply personal" = the corpus is the context; "absolute privacy" = hardware-enforced + client-verifiable, not a policy promise.

---

## 2. The binding constraint — privacy is real *only* for open-weight-in-TEE

### 2.1 The proxy theorem (why closed models are out)
A confidential-inference "proxy" (even one running inside Intel TDX, injecting the upstream key, forwarding to OpenAI/Anthropic) gives the prompt to the lab **in a form the lab must be able to read**, because the model executes on the lab's own, un-attested infrastructure. The lab sees everything (and runs moderation/abuse-retention on it). The TEE proof in that path covers **only the proxy hop** — it proves the forwarder didn't log, not that the inference was private. Verified live: RedPill's catalog has ~33 *proxied* closed models (providers `openai`/`anthropic`/`google`/`x-ai`) sitting next to the TEE-hosted open ones — the same API, completely different guarantee.

### 2.2 The non-negotiable bifurcation
The product must expose **two tiers and never blur them in copy or UX:**

| Tier | Models | Guarantee | Who can see content |
|---|---|---|---|
| **Private** (the promise) | open-weight only, in our attested GPU TEE (Qwen, DeepSeek-OSS, Llama, GPT-OSS, Gemma, GLM…) | **Absolute, verifiable** | the enclave only — *not us, not the host* |
| **Frontier** (opt-in, labeled) | Claude / GPT / Gemini via proxy | **None beyond the lab's policy** | the lab sees plaintext |

If a "deeply personal" prompt (carrying the user's corpus) is ever routed to the Frontier tier, the privacy claim is void for that call. The corpus-bearing path must be **hard-pinned to the Private tier** at the gateway; Frontier is a separate, explicitly-consented, corpus-stripped lane or it doesn't exist.

### 2.3 The only escape hatch
The one way to get a frontier-quality model under the guarantee is for **the lab itself** to serve it from a customer-attestable TEE. Anthropic is researching exactly this ("Confidential Inference via Trusted VMs"). Until a lab ships it *with attestation exposed to us*, frontier ≠ private. Track this; it would collapse the two tiers into one and is the single biggest external unlock.

---

## 3. What "absolute privacy" can honestly mean

State it as a **threat model**, not a superlative:

> *Neither BlitzOS/the operator, nor the cloud host, nor a co-tenant, nor someone who compromises our servers can read your prompts, your personal corpus, or the model's answers — and you can verify this cryptographically from your own device before any data leaves it.*

What it **defeats:** operator snooping, insider access, subpoena of our servers (we hold only ciphertext + keys we can't use without an attested enclave), co-tenant leakage, a breached gateway.

What it **does not** defeat — disclose these, don't paper over them:
- **It requires verifying attestation.** If the client skips the check, it's back to "trust us." Verification must be **mandatory and in the client**, not optional.
- **Physical/side-channel attacks exist.** TEE.Fail / WireTap / BatteringRAM (2025) break Intel TDX/SGX, AMD SEV-SNP, and NVIDIA attestation with <$1k of gear — but **need physical access + root**, can't run remotely, and AMD declares physical attacks out of scope. Cloud-datacenter risk is low; "absolute" means *against remote adversaries and the operator*, not against someone who owns the silicon.
- **Vendor root of trust.** We ultimately trust Intel and NVIDIA's attestation keys. If those break, the chain breaks.
- **Correct code still matters.** A TEE protects data-in-use; it does not fix a bug in our enclave image. The image is part of the TCB and must be reproducible + audited.

The honest marketing line is *"we built it so we can't see your data, and you can check our work"* — verifiable, bounded, true.

---

## 4. The stack we're standing on (how the encryption actually works)

- **CPU (Intel TDX):** workload runs in a Confidential VM; CPU AES-encrypts guest memory; hypervisor/host/operator are locked out.
- **GPU (NVIDIA H100/H200, CC-On):** GPU scrubs state, disables perf counters, runs in an on-die **Compute Protected Region**; each chip has a fused cryptographic identity = hardware root of trust.
- **CPU↔GPU:** data crosses only via **AES-GCM encrypted bounce buffers** (rotating IVs) — never cleartext over PCIe/NVLink.
- **Runtime (dstack):** boots an *unmodified* container, binds a **remote-attestation report** to the exact image hash + args + env. Open-source, audited by zkSecurity (May 2025).
- **Keys (dstack KMS-in-TEE):** releases keys **only after verifying the attestation quote**; operators can't bypass; derives per-app deterministic keys bound to the attested identity. **This is the mechanism we use to gate the per-user corpus data-key.**
- **Attestation chain:** GPU signs a quote → verified via **NVIDIA NRAS** + **Intel DCAP**. Overhead measured **<9%** (near-zero for 70B-class) — so the cost of privacy is *market structure*, not silicon (see §6).

---

## 5. Reference architecture

### 5.1 The gateway's own privacy problem (the crux everyone gets wrong)
"Our own AI gateway" is a trap if built naively: a normal gateway terminates TLS, sees the prompt, routes, re-encrypts to a backend — which means **we see plaintext** and the guarantee is dead at our own front door. Two ways out:

- **(A) Gateway-in-TEE.** Run the router itself inside an attested enclave. It *can* see plaintext but provably can't log/exfiltrate, and clients attest it. Simpler routing & RAG; but the gateway is now a TEE we must operate, and its image joins the TCB.
- **(B) End-to-end-encrypt-to-enclave (the strong form, recommended).** The client encrypts to the **inference enclave's** attested key; the gateway forwards **ciphertext** and sees only routing metadata. The gateway can be ordinary infra (Blitz/CF Worker) because it's blind. Cost: anything we'd normally do at the gateway in plaintext (RAG injection, safety, logging) **must move inside the enclave.**

**Decision:** default to **(B)**. It's the only design where "we cannot see it" is literally true regardless of how our gateway is operated. Use (A) only for the Frontier tier (which has no privacy promise anyway) or as a transition.

### 5.2 The Private-tier request flow (target design)
```
BlitzOS (client, holds user master key)
  1. GET enclave attestation + ephemeral pubkey   ──► Gateway ──► Inference Enclave
  2. verify quote vs trusted measurement allow-list  (CLIENT-SIDE, mandatory)
  3. seal { prompt, corpus-capability } to enclave pubkey
  4. POST ciphertext  ──► Gateway (BLIND: sees model id, token est, timing only) ──►
                                                   Inference Enclave (TDX + H100 CC-On):
                                                     a. decrypt prompt
                                                     b. present attestation to KMS → get user corpus data-key
                                                     c. fetch user's ENCRYPTED corpus (tape/memory/RAG) → decrypt in-enclave
                                                     d. RAG + inference on OPEN-WEIGHT model loaded in-TEE
                                                     e. seal response to client
  5. ◄── ciphertext response ── Gateway ── client decrypts
```

### 5.3 The personal data plane (the "deeply personal" part)
The corpus from `session-tape-and-daydreaming.md` (the append-only tape + derived memory/RAG index) is the crown-jewel asset. Rules:
- **Encrypted at rest, per-user key.** We store only ciphertext.
- **Data-key released only to an attested enclave** via the dstack KMS pattern (§4) — keyed to the enclave measurement *and* the user identity. We (operator) cannot decrypt at will; we lack a usable key outside an attested enclave.
- **RAG happens in-enclave.** Embeddings/retrieval/context-injection all occur inside the TEE; the personal context is *never* assembled at our plaintext gateway.
- **Daydreaming / always-on brain** (guardian-angel) that reprocesses the tape must itself run **inside the enclave** to touch the corpus — otherwise the always-on brain becomes the privacy hole. The "Dream" workspace's inputs are decrypted only in-TEE.

### 5.4 Identity decoupling (defense in depth)
Address the corpus by an **opaque per-session capability**, not a username, so the gateway sees `{model, opaque-token, sizes}` and not *who*. Doesn't replace E2E (content is already sealed) but shrinks the metadata the blind router could correlate.

### 5.5 Client-side attestation verification (the trust hinge)
The verification in step 2 must live **in BlitzOS**, pin a **measurement allow-list** the user's client trusts, and **refuse to send** on mismatch or stale revocation. Surface it as a visible, legible state ("verified private · enclave abc123") — the user's ability to *see and check* the guarantee is the product differentiator, not a footnote. This is the analog of the `provider.call` "host re-asserts the boundary" stance from `dynamic-provider-substrate.md`, pushed to the model hop.

---

## 6. Economics (multi-tenant "for everyone" has to pencil out)

Confidential inference vs commodity (OpenRouter), same open-weight model, live 2026-06-08, blended 1:3 in:out:

| Model | OR out $/M | TEE out $/M | premium (blended) |
|---|---|---|---|
| qwen-2.5-7b-instruct | 0.100 | 0.100 | **1.00×** |
| qwen3.6-27b *(tested)* | 2.400 | 2.700 | **1.12×** |
| gemma-4-31b-it | 0.360 | 0.460 | 1.27× |
| deepseek-v3.2 | 0.343 | 0.480 | 1.40× |
| qwen3.5-27b | 1.560 | 2.400 | 1.54× |
| gpt-oss-120b | 0.180 | 0.600 | 3.37× |
| llama-3.3-70b-instruct | 0.320 | 2.000 | **7.55×** (20× input) |

- **Median premium ~1.4×; bulk of current models 1.1–1.8×; several at parity.** Outliers (4–8×) are *old/commoditized* models OpenRouter sources near-free — avoid those for the Private tier if the ratio matters.
- The premium is **market depth, not silicon** (overhead <9%). The confidential market is shallow (providers: `phala`, `chutes`, `tinfoil`, `near-ai`, `0g`, `secretai`); it will compress as it deepens.
- **Measured anchor:** a real `qwen3.6-27b` call cost **$0.00111** for 19in+410out — matched the chutes-provider rate ($0.32 in / $2.70 out per 1M) to the cent. At ~2M output tok/user/mo on a mid open model, the *privacy tax* is **cents-to-low-dollars per user/month** — viable for "everyone."
- **Data-plane / enclave hosting:** Phala Cloud CPU TEE (TDX) `tdx.small/medium` = **$0.06–0.12/hr**; GPU TEE (H200) **$3.50/hr on-demand, $2.56/hr committed**. Dedicated GPU only beats per-token at sustained high utilization; default to per-token confidential inference, reserve GPU for steady load.

---

## 7. Build vs buy

- **Buy (RedPill aggregator):** fast, multi-provider, OpenAI-compatible, `/v1/models` public+priced. But you trust *its* routing + the chosen provider's attestation, and — fatal for the strong form — you generally **can't E2E-encrypt to the actual inference enclave** through it, so either RedPill or your gateway terminates plaintext. Fine for the **Frontier tier** and for prototyping; **insufficient** for the absolute-privacy promise.
- **Build (own dstack on Phala GPU TEE):** we control the enclave image, expose **its** attestation + pubkey directly to clients, and do **E2E-to-our-enclave** (§5.2). More ops (image reproducibility, KMS, attestation allow-list, model loading in-TEE), but it's the **only** path where the §0 promise holds.

**Recommendation:** **Build** the Private tier on our own dstack enclave; optionally **buy** (proxy through RedPill) for the clearly-labeled Frontier tier. Don't let the convenience of the aggregator quietly become the thing we call "private."

---

## 8. Open decisions
1. **Which TEE provider/silicon to standardize + audit first** (Phala/dstack on H100 vs H200; whether to pin a single attested image).
2. **E2E-to-enclave (B) vs gateway-in-TEE (A)** as the launch design — (B) is stronger; (A) is faster to ship. Possibly A→B migration.
3. **Key custody:** does the *user* hold a master key (true zero-knowledge; loss = data loss) or do we hold wrapped keys releasable only to attested enclaves (recoverable, slightly weaker "absolute")? This is the sharpest product/privacy tradeoff.
4. **Private-tier model menu** — which open-weight models, refreshed as the frontier of open weights moves (this list churns monthly).
5. **Frontier tier: offer at all?** If yes, exact corpus-stripping + consent UX so it can't be confused with Private.
6. **Attestation-verification UX** in BlitzOS — how the "verified private" state is shown and what happens on mismatch.
7. **Where the always-on brain runs** — it must be in-enclave to touch the corpus (§5.3); reconcile with guardian-angel's cost/safety firewall.

## 9. Next steps
- [ ] Spec the **enclave image** (dstack container: open-weight model server + in-TEE RAG over the user corpus + KMS-gated data-key fetch).
- [ ] Spec the **E2E handshake** (attestation fetch → client verify → seal-to-enclave-pubkey → blind gateway forward).
- [ ] Prototype on **own dstack / Phala GPU TEE** with one model (qwen3.6-27b — already cost-anchored) and a dummy corpus; verify a real attestation client-side end to end.
- [ ] Decide #3 (key custody) — it gates everything else.
- [ ] Wire the **Private/Frontier tier split** into the `provider.call`/model-routing layer so corpus-bearing calls are hard-pinned to Private.

---

*Written from a 2026-06-08/09 research session. The confidential-inference market and TEE attack surface move fast; treat §4/§6 as point-in-time and re-verify before committing engineering.*
