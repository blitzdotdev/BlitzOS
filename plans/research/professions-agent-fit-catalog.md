<!-- Generated 2026-06-05 via an unbiased multi-agent sweep (12 economic sectors, O*NET-SOC / ISCO-08 backbone, + bias & completeness critics). 232 occupations; 78 high-fit. Product research for which professions an agent-OS could serve — assist-fit vs substitution-exposure, by modality. -->

# The Honest Agent-Fit Catalog of Human Work

*A bias-corrected, all-of-work assessment of where an AI agent — one that perceives a worker's live context and acts in their tools — genuinely assists, where it merely automates paperwork, where it substitutes the role outright, and where it has no purchase at all.*

---

## 1. The Evaluative Lens (and what it is NOT)

**The question is narrow and specific:** *Can an AI agent that perceives a worker's working context and can act within it meaningfully help this person do their actual job?* That is **assist-fit**, and it is a different axis from **substitution-exposure** (will automation/robotics eliminate the role). Many of the highest-headcount frontline jobs are **low assist-fit but high substitution-exposure** — an agent can't help the cashier, but the self-checkout kiosk replaces them. Where the two diverge, this catalog flags it, because collapsing them understates disruption for exactly the workers who can least afford it.

**This catalog deliberately spans ALL work**, not the screen-bound knowledge minority that automation discourse over-indexes on:

- **Physical / field / craft** work (welders, roofers, farmworkers, surgeons, line cooks)
- **Voice / earpiece / hands-busy** frontline work (nurses, drivers, paramedics, pickers)
- **AR-wearable** trades (electricians, HVAC techs, assemblers, log scalers)
- **Robotic/embedded** substitution domains (cashiers, sorters, mining machines)
- **Global & informal** labor (street vendors, smallholders, waste pickers, brick-kiln workers, mobile-money agents) — where the *majority of the world's workers actually are*
- **Unpaid & household** work (family caregivers, homemakers) — the single largest category of human work-hours on Earth, which formal taxonomies (SOC/ISCO count only paid jobs) structurally erase

**Three biases this catalog actively corrects** (per the audit):
1. **The "documentation tail" inflation** — splitting a 70%-physical job into "physical core (none) + clerical tail (high)" and scoring the whole role *medium*. The clerical relief is real but is usually 15–30% of hours. Where a role is rated medium on that basis, this catalog says so plainly and notes the dominant physical share.
2. **Desk-work over-weighting** — the reflexive "the real story is the hidden knowledge worker." This catalog gives the world's most common jobs first-class analytic attention, not one-line dismissals.
3. **Western/formal-economy skew** — connectivity, device access, literacy, and shared language are treated as **first-order constraints**, not edge-case caveats. For billions of workers the reach modality is a feature-phone IVR in a local language, not a SaaS dashboard.

**Modality tags:** `desktop` · `mobile` · `voice/earpiece` · `AR-wearable` · `robotic/embedded` · `none`.

---

## 2. The Catalog, by Agent-Fit Tier

### TIER: HIGH FIT
*The work product is largely structured language / data / rules at a screen the agent can perceive and act in. Note: "high fit" frequently means high displacement, not a gift to the worker.*

#### Desktop-native
| Occupation | What the agent would do |
|---|---|
| **Software / Web Developer** | Read the repo and live editor/terminal, write and refactor code, run tests, triage stack traces, open PRs (this very tool is the existence proof). |
| **Database/Data Engineer, InfoSec/SOC Analyst** | Inspect schemas and query plans, write/optimize SQL and pipelines, correlate alerts, draft incident timelines — destructive prod actions gated by human approval. |
| **Data Scientist / ML Engineer, Statistician/Bioinformatician** | Run EDA, write modeling/feature code, sweep experiments, produce evaluations and the narrative in the notebook/warehouse. |
| **Economist / Survey & Social Researcher** | Build econometric models, clean and analyze data, run robustness checks, draft briefs and visualizations. |
| **Civil/CAD Drafter, GIS Technician** | Convert markups into CAD detailing, run spatial joins, script repetitive geoprocessing — the most agent-exposed tier *inside* engineering. |
| **Accountant/Auditor, Bookkeeping Clerk, Financial Manager/Controller** | Run the close, reconcile ledgers, full-population (not sampled) audit checks, draft commentary — human sign-off (SOX/independence) is the only ceiling. |
| **Financial Analyst, Cost Estimator, Comp/Benefits Specialist** | Pull and clean data, build/update models, benchmark, run pay-equity and sensitivity analyses, draft notes. |
| **Actuary** *(added)* | Build mortality/risk/pricing models, run stochastic simulations, draft reserving and regulatory reports — credentialed human attests. |
| **Real Estate Appraiser/Assessor** *(added)* | Assemble comps, compute USPAP adjustments, draft the appraisal (AVMs already do much of this); physical inspection + licensed sign-off remain human. |
| **Securities/Commodities Traders & Brokers** *(added)* | Surveil markets, execute within parameters, draft research, monitor risk — custody/irreversible value transfer stays human-gated (the crypto-treasury pattern). |
| **Paralegal/Legal Assistant, Title Examiner, Detective/Criminal Investigator** | Assemble document sets, cite-check, calendar deadlines; cross-reference records/financials/timelines to surface connections, draft warrant affidavits — the "action" job that is really document synthesis. |
| **Lawyer (litigation/transactional)** | Draft and red-line contracts/briefs, run citation research, build chronologies and privilege logs, prep deposition outlines — accuracy + UPL/malpractice liability keep the human signing. |
| **Court/Reporter & Captioner** | Real-time speech-to-text with speaker attribution — high-displacement; the defensible remnant is the certified-accuracy attestation. |
| **Radiologist, Medical Records/Coder, Speech-Language Pathologist** | Pre-read worklists and pre-populate structured reports; auto-suggest/validate ICD/CPT codes; transcribe and score sessions and auto-draft evaluations — the highest-fit *clinician* roles are the most screen-and-language-bound, not the most prestigious. |
| **Medical Assistant (admin half), Clinical Research Associate** *(CRA added)* | Automate scheduling/prior-auth/insurance and message triage; cross-check protocol compliance, verify source data vs. CRFs, draft regulatory submissions (FDA/GCP gates autonomy). |
| **Secretary/Admin Assistant, Data Entry Keyer, Order Clerk, General Office Clerk, Loan Interviewer/Clerk** | The canonical computer-use targets: schedule, draft and send routine email, generate reports/slides, OCR-and-key documents end-to-end with the human on exception review. |
| **Court/Municipal/License Clerk, Tax Examiner/Revenue Agent, Eligibility/Benefits Interviewer, Compliance Officer, Insurance Underwriter, Loan Officer** | Process filings, verify documents against statute/rules, auto-screen returns, monitor transactions, score risk, draft notices/determinations — *but see the friction note below; due-process and fair-lending accountability are the real ceiling, not capability.* |
| **Graphic Designer, Multimedia Artist/Animator, Technical Writer, Editor, Writer/Copywriter, PR Specialist, Proofreader** *(proofreader added)* | Generate variants on the live canvas, draft/restructure/fact-check text in the doc/CMS, copyedit in place, enforce style — proofreading is near-fully automatable (high-displacement). |
| **Instructional Designer / Curriculum Developer** *(added)* | Author curricula, learning objectives, assessments, and e-learning modules; align to standards; personalize pathways. |
| **Concierge** | Make reservations, build itineraries, answer local questions in any language 24/7 — a surprise high-fit role inside a "personal service" sector. |
| **Emergency Management Director** | Draft and update emergency-operations plans, fuse weather/911/GIS/resource feeds into a common operating picture, generate SITREPs and public messaging. |
| **Military Intelligence Analyst** | Fuse multi-source data, flag patterns, draft assessments and briefings, translate foreign material — high fit *within* secure/airgapped environments; the combat core is off-limits. |
| **Sustainability/ESG Specialist, Forester, Conservation Scientist** | Aggregate emissions/inventory data, compute against protocols, draft disclosures and management plans, navigate NRCS/government cost-share paperwork. |
| **Logistician/Supply-Chain Analyst, Purchasing/Procurement Buyer, Commercial Dispatcher** | Forecast demand, optimize inventory/routing, run RFx and bid comparison, auto-assign and re-route — *commercial* dispatch only; 911 dispatch is a separate role (see Medium). |
| **First-Line Production Supervisor, Food Service Manager, Ag Crew-Boss Supervisor** | Auto-build schedules and line balances, watch MES/OEE telemetry, reconcile food/labor cost, tally piece-rate, and **live-translate** for multilingual crews — supervisory layers out-score the workers they manage. |

#### Voice / earpiece-native (high-volume, scripted, outcome-measured)
| Occupation | What the agent would do |
|---|---|
| **Telemarketer, Bill/Account Collector, Switchboard/Telephone Operator** | Hear the live call + CRM, surface the next line/rebuttal, auto-log disposition, dial next — and increasingly *be* the caller. Regulatory consent is the brake, not capability. |
| **Customer Service Rep, Call-Center/BPO Agent** | On chat/email draft or fully send and execute the adjustment; on voice transcribe, suggest, and auto-complete wrap-up. Tier-1 is being absorbed; humans escalate to empathy/edge cases. |

#### Mixed (high overall, channel depends on context)
| Occupation | What the agent would do |
|---|---|
| **Quality Control Inspector** | Vision-based defect detection, automatic SPC/metrology analysis, CAD-vs-part comparison, auto-generated conformance records — the standout production-sector fit; assists *and* substitutes routine visual sorting. |
| **Interpreter/Translator** | Document translation at scale with the human post-editing; live interpreting via earpiece with the human holding certified/high-stakes nuance — arguably the most AI-native occupation that has both a desktop and a voice form. |
| **Social Media/Content Creator, Live Streamer, Micro-influencer/UGC, OnlyFans Creator** | Run the whole production-and-growth pipeline (clip, caption, thumbnail, schedule, A/B, moderate, pitch deals, DM sales funnel, DMCA, bookkeeping) — only the on-camera persona/body is non-substitutable; sharp consent/disclosure ethics on impersonation. |
| **Freelance Knowledge Worker, Indie Founder/Solopreneur, Virtual Assistant, Affiliate/Dropshipper, Crypto/DAO Operator, Prompt Engineer** | All-digital: produce the billable artifact, run support/marketing/billing, read on-chain state natively. Often *self-eroding* (prompt engineer dissolves into general eng; arbitrage margins evaporate when everyone runs the same agent). VA is the most directly substitutable role on the map. |
| **Data Labeler/RLHF Rater, Microtask Transcriber/Captioner, Content Moderator** | Pre-fill annotations, ASR the draft, auto-resolve clear-cut moderation — the sector's sharpest irony: highest fit because the work *is* what trains agents; high fit = existential displacement (moderation automation is also humane — less trauma exposure). |

---

### TIER: MEDIUM FIT
*Bimodal roles — a genuinely automatable cognitive/admin half bolted to an irreducible physical, relational, or accountable core. The honest read is often "automate the documentation, never the legitimacy." Several of these were pulled here from "high" by friction, or are honestly capped because the dominant share of hours is physical.*

#### Desktop-leaning
- **Chief Executive / General Manager** *(mixed)* — Synthesize briefing packs, draft/triage correspondence, run scenario models, action meeting outcomes; *the accountable bet cannot be delegated.*
- **Personal Financial Advisor, Loan Officer, Insurance Underwriter** *(re-rated down from high)* — Capability is high, but fair-lending explainability, adverse-action law, fiduciary liability, and slow institutional adoption are the binding constraints. Friction-adjusted fit is medium.
- **Civil / Mechanical / Electrical / Aerospace Engineer, Architect** — Run calcs/CFD/FEA, draft and code-check drawings, generate permit/construction-document sets; the **PE/RA stamp legally requires a human** and physical test/integration is embodied.
- **Environmental Scientist, Urban Planner, Petroleum/Mining Field Engineer** — Model contaminant spread / run GIS / run reservoir sims and monitor dense telemetry, draft regulatory filings; field sampling and politically-charged public hearings stay human. (Telemetry gives unusually rich *remote perception* of a site the agent can't touch.)
- **Postsecondary Professor, K-12 & Special Education Teacher, Career Counselor, Religious Education Director** — Generate differentiated lessons, auto-grade and feedback, **draft the enormous legally-templated IEP/SPED documentation**, match students to courses/colleges; classroom management and safeguarding minors are in-person and non-delegable.
- **Dietitian/Nutritionist** *(added)* — Generate personalized meal/nutrition plans, carry the insurance-justification documentation; the behavior-change counseling relationship stays human.
- **Probation/Parole Officer** — Draft pre-sentence/violation reports, run structured risk scoring (needs bias guardrails), track conditions; supervisory authority over liberty stays human.
- **Mortician/Funeral Director** *(desktop)* — Automate the heavy permit/certificate/coordination/obituary paperwork; embalming and consoling the bereaved are physical and human.
- **Chemical/Power-Plant & Petroleum Operator** *(modality correction: NOT a personal desktop copilot)* — Monitor DCS/historian data, predict upsets, automate shift logs; **the real surface is an embedded advisory overlay gated by safety certification** (closer to the anesthesiologist's embedded class). External agents often can't act on or even read a certified console.
- **Legislator/Elected Official** *(desktop)* — Summarize bills, analyze fiscal impact, draft correspondence/speeches, triage casework; deliberation, representation, and the vote are reserved.
- **Product Manager (software)** *(added; mixed)* — Mine feedback, write specs/PRDs, run the coordination spine; the bet on *what to build* and cross-team politics are human.

#### Mixed / field-mobile
- **Management Consultant, Project Manager, Event Planner, Fundraiser, HR Specialist, Training Specialist, Real Estate/Insurance Agent (back-office), Property Manager, Claims Adjuster** — A high-fit analytical/admin engine (analysis, scheduling, prospect research, screening, marketing, paperwork, photo-based claim estimating) wrapped around human trust, persuasion, mediation, in-person presence, or physical inspection. *Many of these are bimodal — the desk half is high, the field/relational half is human.*
- **News Reporter/Journalist, Producer/Director, Coach/Scout, Photographer, Camera/Film Editor, Music Composer, Fashion/Interior/Set Designer, Broadcaster, Beekeeper** — Transcribe/research/draft, break down game film, auto-cull and rough-cut footage, generate design variants and tech packs, feed a live earpiece during a segment; the on-scene reporting, on-set direction, the shoot, fittings, and live delivery are embodied. *(Often the right unit is the task: an editing-only or composing-only specialist would rate high.)*
- **Veterinarian, Field Vet/Livestock Tech, Animal Breeder** — Ambient scribe for owner visits, AI imaging reads, dosing/protocol lookup, per-animal records; **animal breeding is a surprise — its core is genetic selection, estrus scheduling, and registry compliance** (structured optimization), not muscle. Physical exam/insemination stays manual.
- **Construction Manager / Site Superintendent** *(added; mixed/mobile)* — On a phone: scheduling, RFIs, submittals, change orders, daily logs, budget tracking; field walks, sub-coordination, and safety stay human. A larger, more agent-reachable role than the individual trades.
- **HVAC/R Mechanic, Elevator/Escalator Repairer** *(AR-wearable)* — These read as manual trades but are **diagnostic-and-documentation occupations**: most billable time is interpreting fault codes and hunting proprietary OEM service manuals — exactly the bottleneck an agent removes. Physical repair stays manual.
- **Auto/Diesel/Heavy-Equipment Mechanic** *(mixed)* — Ingest scan-tool/telematics data, correlate with TSBs, propose ranked diagnoses, look up specs, draft the repair order; physical R&R is human.
- **Aircraft Mechanic, Telecom Installer, Security/Fire-Alarm Installer, Industrial Millwright, Appliance/Field-Service Repairer, General Maintenance Worker** — Pull the exact AD/SB/manual step, auto-generate compliant logbook/certification records, guide device programming and network config (a genuinely screen-adjacent, partly remote slice), identify parts from photos, run the CMMS. Physical mounting/wiring stays manual.
- **Fitness Trainer** *(mobile)* — Generate periodized programs, **analyze form from phone video**, track progress, handle scheduling/billing; in-person motivation and spotting are human.
- **Tour Guide** *(voice)* — Generate scripts/itineraries, answer obscure questions and translate live via earpiece; **self-guided audio/AR already partly substitutes** — a real partial-substitution case in a face-to-face sector.
- **Child/Family & Healthcare Social Worker, Social/Human Service Assistant** *(mobile/desktop)* — On a phone in the field: transcribe visit notes, draft court reports and case plans, **navigate byzantine benefits portals** (the surprising bulk of the job); risk assessment and family trust are in-person. *(Human Service Assistant rates high — the bureaucracy is most of the value.)*
- **Pest Control / Pesticide Applicator** *(mobile)* — Identify pests/labels, surface legal rate/buffer/re-entry rules, calculate mix ratios, auto-generate the mandatory regulatory record; physical application stays manual.
- **Agricultural Inspector** *(high, mobile)* / **Fish & Game Warden, Park Ranger, CBP Officer** *(medium, mobile/mixed)* — Pull the reg/standard on the spot, structure findings from photos/dictation, image-analyze cargo X-rays, draft citations; physical patrol, confrontation, discretion, and patchy connectivity cap the field-enforcement set.
- **Farmer/Rancher (owner-operator)** *(high on the business half, mixed)* — Plan plantings/herd decisions against weather and prices, navigate crop-insurance and subsidy paperwork, broker sales — a big latent opportunity; the physical half stays human.
- **Machinist, Ag Equipment Operator, Sailor/Ship's Officer** — Generate/verify G-code and feeds/speeds, set spray/seed rates from prescription maps, do voyage planning and collision-avoidance decision support and the brutal fisheries/maritime compliance paperwork; fixturing, cab control, and deck work are manual, and **connectivity at sea is the binding constraint**.
- **911 / Emergency Dispatcher** *(added; medium, voice — corrects the sweep's blanket exclusion)* — Call transcription, address/CAD auto-population, EMD protocol-card prompting, resource recommendation (already deployed); the emotional/judgment core stays human.

#### The honest "documentation-tail" cluster (rated medium, but the dominant share of hours is physical)
*These are NOT 50/50. The clerical relief is real and high-acceptance — it removes the burden workers most resent — but the actual labor is 60–80% embodied. Read "medium" as "a valuable voice/AR assist on a small admin slice of a physical job," not "half the job is automatable."*
- **Family Medicine / Primary Care Physician, Nurse Practitioner / PA** *(desktop)* — Ambient scribe drafting the note and orders, in-basket triage and reply drafting, prior-auth letters; every diagnosis/prescription is human-confirmed and the physical exam is irreducible.
- **Registered Nurse, Respiratory Therapist** *(voice/mobile)* — Voice-driven bedside charting, med-pass five-rights check, auto-SBAR handoff, vital-trend flags; ~70% of the shift is embodied care the agent cannot touch.
- **Paramedic/EMT** *(voice)* — Hands-free run-report dictation, protocol/dose readback, hospital pre-alert; the lifesaving acts are physical.
- **Police/Sheriff Patrol Officer** *(voice)* — Hands-free plate/warrant lookup, bodycam-to-report drafting, in-the-moment policy lookup; the physical-confrontation core is none and the agent must **never** be in that loop.
- **Pharmacist** *(modality correction toward voice)* — Automate interaction/dose/duplicate-therapy checks and insurance-rejection resolution; counseling and final verification are human and the role is interruption-driven, not a quiet desktop.
- **Security Guard (surveillance-room slice), TSA Screener, CBP (booth slice)** *(perception-layer)* — Persistent CCTV/X-ray anomaly detection that watches better than a fatiguing human and *cues* them — partially displacing the boring-vigilance core while physical response stays human.

---

### TIER: LOW FIT
*The defining act is manual, intimate, in-person, real-time, safety-critical, or off-grid. An agent can touch only a thin periphery (logging, lookup, booking, prep). Many here are simultaneously **high substitution-exposure** via robotics — flagged inline.*

| Occupation | Modality | What the agent can touch (the thin slice) |
|---|---|---|
| **Surgeon, Dentist** | AR-wearable | Heads-up imaging/checklist overlay, voice op-note/charting; the procedure is irreducibly manual (high status ≠ high fit). |
| **Dental Hygienist** | voice | Hands-free perio charting while hands stay in the mouth; the scaling dominates. |
| **Physical/Occupational Therapist & Assistants** | mobile | CV gait/ROM measurement, rep-counting, insurance-justification notes; manual therapy is human. |
| **Radiologic Technologist / Sonographer** *(re-rated down from medium)* | embedded/console | Exposure/protocol suggestion and QA at the console; **patient positioning and probe manipulation dominate** — not a personal desktop agent. |
| **Med-Lab / Pharmacy Technician** | desktop | Delta-check/result auto-verification, insurance rejection, reorder; specimen handling and physical dispensing are manual. |
| **Lifeguard / Ski Patrol** | AR-wearable | Drowning/avalanche detection cues the human; the rescue is irreducible. |
| **Mining Roof-Bolter, Heavy-Equipment/Crane Operator, Logging Equipment Operator, Locomotive Engineer, Forklift Operator** | robotic-embedded / voice | Boundary/buffer warnings, fault-code help, load-chart lookup; **the automation here lives in the machine (autonomy/teleoperation/PTC), not a wearable** — it removes the human from danger rather than coaching them. |
| **Plumber, Carpenter, Welder, Solar Installer, Roofer (planning only)** | AR-wearable / voice | Code lookups, pipe-sizing/cut-list/string-sizing math, weld-spec retrieval, post-hoc visual defect flags; the craft is in the hand. |
| **Electrician** | AR-wearable | **Highest of the trades** — live NEC/diagram overlay on the panel, load/conduit-fill calcs, troubleshooting trees; execution is still manual. Adoption hinges on rugged hands-free hardware. |
| **Electrician's/QC/Calibration Technician, Surveyor, Log Grader/Scaler** | AR-wearable | Read measurement output, apply scaling/tolerance rules, auto-generate certificates; **occupying and measuring the physical point/part is the defining act**. |
| **Line Cook, Barista, Bartender** | AR-wearable / voice | Ticket sequencing, recipe recall, allergen flags, pour-cost/inventory back-office; heat, craft, and judgment dominate. |
| **Waiter/Server** | mobile | Table-turn timing, course-firing, check-splitting, pairings on a handheld; carrying plates and reading a table are the job. |
| **Hairstylist, Manicurist, Esthetician, Massage Therapist, Dental Assistant, Athletic Trainer** *(latter three added)* | mobile | Booking/CRM/retail, design or skin/regimen preview, treatment logs; the manual craft **and** the personal relationship are the paid product. |
| **Animal Caretaker/Groomer, Animal Control** | mobile | Booking, health/feeding logs, owner updates, ordinance lookup, symptom flagging; handling is manual and unpredictable. |
| **Maid/Housekeeper, Landscaper, Recreation Worker, Forest/Conservation Worker, DJ/Live Entertainer, Floral/Fine Artist (physical)** | mobile / desktop | Assignment/route/job-quote optimization, plant/pest ID, setlists, portfolio/marketing; for physical artists, generative AI is a *substitute product*, not an assistant (consent/IP concerns). |
| **Musician/Singer, Actor** | none | Setlist/booking admin, line-rehearsal partner, audition logistics; the embodied performance is the job — synthetic versions are replacement tech, not assistance. |
| **Personal Care Aide, Home Health Aide, CNA/Orderly, Vet Tech, Psychiatric Aide, Mental Health/Substance-Abuse Counselor, Community Health Worker, Clergy, Elder Care Aide** *(elder care added & elevated)* | voice / mobile | Voice/mobile logging of vitals/visits/care tasks, med reminders, escalation flags, translation; **the physical, intimate, trust-based core is the deliverable and is non-delegable**. For therapists/clergy/CHWs, *being a trusted human* is the product — no modality substitutes. Documentation relief only. |
| **Correctional Officer** | AR-wearable | Dictated counts/incident reports, classification lookup; the floor often bans devices for security — the environment fights the modality. |
| **Fish & Game Warden (re: connectivity), Hunting/Trapping Worker** | voice/mobile | Reg/license/species lookup, harvest logging — gated by remote dead zones (offline-first is the unlock). |
| **Enlisted Combat / Infantry** | AR-wearable | Rear-area planning, logistics, sensor fusion, training sims; the kinetic core is off-limits and frontline comms are intentionally constrained. |
| **Retail Salesperson, Counter/Rental Clerk, Parts Salesperson** | AR-wearable / robotic / voice | Whisper inventory/price/compatibility; **Parts is a sleeper** — VIN/photo part-ID and phone orders are end-to-end automatable, lifting it toward high on the lookup half. |
| **Shipping/Receiving Clerk, Stocker/Order Filler, Mail Carrier, Bus/Taxi/Rideshare/Delivery Driver, Truck Driver, Postal Window Clerk, Bank Teller, Toll/Parking/Meter roles** *(latter three added)* | voice / robotic-embedded | Routing, ELD/HOS compliance, dispatch comms, scan/POD, float/cash reconciliation; **driving's value is on the periphery** (the AV stacks chase the wheel). Bank tellers and toll/meter roles are **low assist-fit but high substitution-exposure** (ATMs/apps, e-tolling/ANPR). |
| **Smallholder/Subsistence Farmer, Street Vendor/Market Trader, Mobile-Money Agent, Reseller/Flipper, Gig Handyman/TaskRabbit** | voice (feature-phone/IVR) / mobile / AR-wearable | Local-language planting/pest/price advice, cash-flow/float tracking, listing/pricing/cross-posting, AR repair guidance; **connectivity, device cost, literacy, and language are the binding constraints, not capability**. Gig handyman is the most plausible AR-wearable frontier (turn a generalist into a multi-trade worker) — *low now, watch this space*. |
| **Butcher/Meat Cutter, Baker** *(added)* | mobile | Yield/portion math, ordering, HACCP logging, recipe scaling; the cutting/baking craft is durable manual work. |
| **Flight Attendant** *(added)* | AR-wearable | Pre-flight briefing prep, special-needs/manifest lookup, post-flight reporting; in-cabin safety authority and service are embodied and regulated. |
| **Air Traffic Controller** *(added)* | embedded/advisory | Conflict-prediction decision support, off-position paperwork, training sims; **real-time separation authority is deliberately reserved for a certified human** — the pilot pattern. |

---

### TIER: NONE
*No addressable surface for a perceive-and-assist agent. The work is pure embodied labor, intimate human safety, or device-hostile — and where "AI" appears, it is **robotics that substitutes**, a categorically different technology.*

| Occupation | Why none | Substitution note |
|---|---|---|
| **Biological / Lab Technician** | Fine-motor sterile sample handling; perception limited to whatever instruments digitize. | Flips to high only in self-driving (robotic) labs — *modality, not intelligence, is the gate*. |
| **Surgical Technologist** | Sterile manual instrument anticipation; no screen, no voice surface. | Camera-based sponge counting is a sensor system, not an agent. |
| **Phlebotomist** | Brief manual venipuncture; only ID/label checks exist. | Vein-finder devices help; no assist surface during the draw. |
| **Preschool/Childcare Worker, Teaching Assistant** | Continuous physical safety and supervision of minors; trust is the basis. | No modality reaches this; parents won't cede safety. |
| **Library Technician (physical), Athlete/Sports Competitor, Bailiff** | Physical handling/shelving; embodied competition; courtroom decorum forbids device use. | Bailiff is the benchmark "true zero-surface" role — not a capability gap, no information core at all. |
| **Dishwasher, Janitor/Building Cleaner, Amusement Attendant** | Wet/physical labor with no information layer. | Floor scrubbers / kiosks substitute (hardware), not advisory agents. |
| **Cashier, Counter Clerk** | Physical transaction throughput, minimal cognitive load. | **Self-checkout / CV-carts substitute** — the "AI assist" frame is simply wrong here. |
| **Graders/Sorters (Ag)** | Perceptual-motor sorting at line speed. | **Optical sorters substitute** — "automatable" ≠ "agent-assistable". |
| **Sewing Machine Operator, Meatpacking/Poultry Line Worker** *(latter added)* | Fine-motor manipulation of deformable material/tissue at speed; hands occupied, no screen. | Robotics has resisted limp fabric/soft tissue for decades — key global-South/migrant blind spot. |
| **Construction Laborer, Stock/Material Mover, Refuse Collector, Crane Operator (in-act), Packaging Tender, Warehouse Packer/Sortation Associate** *(latter added)* | Undifferentiated physical effort, no knowledge bottleneck, often no screen. | Goods-to-person robotics / automated side-loaders **substitute** — none assist-fit, **high substitution-exposure** (e-commerce fulfillment is among the fastest-growing physical work). |
| **Faller (Tree Cutter)** | Split-second, high-risk cutting; an interface mid-cut is a hazard. | Mechanized harvesters substitute via the machine. |
| **Airline/Commercial Pilot** | Certified two-person safety envelope; no third-party agent acts in flight. | Off-flight planning is assistable; autopilot already handles routine — the human exists for the non-routine and accountable. |
| **Crop/Greenhouse Farmworker, Farm Animal Worker, Commercial Deckhand** | Stoop labor / animal handling / wet deck work; no device, often offline. | Capital flows to harvesting/herd robotics, not personal agents. |
| **Domestic Worker / House Cleaner / Nanny, Waste Picker, Brick-Kiln/Informal Laborer** *(latter two added)* | 100% manual, in-home/off-grid, trust-bound; often no literacy/language/connectivity match. | The world's largest informal workforces, with effectively zero agent surface — the clearest puncture of "AI eats everything." |

---

## 3. MODALITY MAP — the key unbiasing insight

The session over-indexed on **desktop**. The reality is that *which modality reaches the worker matters more than how capable the model is.* Work distributes across six modalities, only one of which is the keyboard:

| Modality | What kinds of work it reaches | Representative roles | Why this is the right channel |
|---|---|---|---|
| **Desktop / web** | Screen-bound knowledge & admin work; the *minority of global headcount* but the majority of "high fit". | Developers, analysts, accountants, paralegals, radiologists, coders, clerks, drafters, examiners, supervisors, VAs. | The agent can both perceive (read the editor/EHR/CRM/ledger) and act (write code, file forms, draft reports) in the same environment. |
| **Mobile (phone-in-the-field)** | Field professionals and gig workers whose context is a doorstep, a home, a site, a stall — not a desk. | Social workers, home-health aides, pest control, inspectors, crew bosses, couriers, resellers, street vendors, smallholders, construction superintendents. | The worker already lives on a phone; the agent captures context via camera/voice and handles back-office between physical tasks. **The work happens at the doorstep, not in a web app** — assuming desktop here misses where the job is. |
| **Voice / earpiece** | **Hands-busy, eyes-committed** frontline work where a screen is unsafe or impossible. | Nurses, paramedics, police, drivers, pickers, line cooks, dispatchers (911), telemarketers, BPO agents, CNAs. | The only viable channel when both hands and eyes are occupied. **Voice is systematically under-assigned** — the default to "desktop/mixed" for hands-busy roles is a core bias. For billions, the form is a **feature-phone IVR/USSD in a local language**, not an app. |
| **AR / wearable** | Manual trades and craft where guidance must overlay the physical work surface. | Electricians, HVAC, assemblers, welders (in-hood), surgeons, log scalers, gig handymen, QC/calibration techs. | Hands-free overlay of diagrams, codes, fault meanings, step-by-step procedures on the actual object. **The frontier modality** — high potential, but rugged/affordable jobsite hardware is still immature, so most AR-tagged roles are "low now". |
| **Robotic / embedded** | Where the "agent" lives inside the machine, the console, or the monitor — not on a person. | Anesthesia (closed-loop monitors), chemical/power-plant operators (DCS overlay), heavy-equipment/mining (autonomy), forklifts (AMRs), cashiers (self-checkout), sorters (optical). | Two distinct sub-cases: **embedded advisory** (safety-certified consoles an external agent can't touch) and **embedded substitution** (robotics that replaces the body). Mapping these to "desktop" overstates the reachable action surface. |
| **None (no-good-fit-yet)** | Pure embodied labor, intimate human safety, sterile/wet/dangerous device-hostile work. | Surgical techs, phlebotomists, childcare, bailiffs, dishwashers, sewing/meatpacking operators, fallers, domestic workers, waste pickers. | No screen, no voice surface, no documentation overlay — and where automation arrives, it is robotics that substitutes, not software that assists. |

**The cross-cutting correction:** in physical sectors, nearly every role splits into a **cognitive/admin half** (manuals, codes, calcs, diagnostics, compliance records — agent-augmentable) and a **physical-execution half** (not). Agent fit tracks the *size of the cognitive half* — and the single most repeated source of real value across physical sectors is **regulatory/compliance paperwork automation** (pesticide logs, fisheries catch reports, NRCS forms, H-2A docs, food-safety inspections, IEPs, run reports, logbooks), not the physical work.

---

## 4. MOST-NUMEROUS JOBS REALITY CHECK

A product that targets where workers *are* must confront the highest-headcount occupations on Earth — almost all physical, frontline, and (correctly) low or no assist-fit. Honest fit + the right modality:

| Job (≈ rank by global/US headcount) | Honest assist-fit | Right modality | The reality |
|---|---|---|---|
| **Retail Salespersons** | **low** | AR-wearable / voice | A real-time knowledge prosthetic (inventory, price, compatibility) helps — but the worker has no free hands and no screen mid-sale. Hardware isn't there. |
| **Cashiers** | **low (assist) / HIGH substitution** | robotic-embedded | "Agent assist" is the wrong frame; self-checkout and CV-carts **replace** the role. |
| **Drivers (truck/delivery/rideshare/bus/taxi)** | **medium–low** | voice/earpiece | High-value cognitive layer (routing, HOS/ELD compliance, multi-app earnings arbitrage, dispatch) — deliverable **only by voice** because hands/eyes are on the road. The wheel itself is for AV stacks, not assist agents. |
| **Farmworkers (crop/animal)** | **none–low** | none / AR-wearable | Stoop labor and animal handling; capital flows to harvesting/herd robotics. The crew **boss**, not the worker, is the agent target (live translation, piece-rate, H-2A). |
| **Cooks & Food-Prep / Fast-Food** | **low–medium** | AR-wearable / voice | Order capture (voice/POS) is genuinely automatable; the cooking and station work are not. Split medium for fast-food, low for line cooks. |
| **Cleaners (janitors/maids)** | **none–low** | robotic-embedded / mobile | Manual cleaning dominates; the only surface is assignment/status/reporting on a phone. Robotic scrubbers are the substitution vector. |
| **Care / Home-Health Aides, CNAs, Elder Care** | **low** | voice/mobile | **One of the largest and fastest-growing occupations on Earth** (global aging) and among the most durable — the physical, intimate, trust-based core is the deliverable. Agent helps only with logging, reminders, translation, family comms. *Headcount vastly exceeds the analytic attention usually given.* |
| **Construction Laborers** | **none** | none | Undifferentiated physical effort, no knowledge bottleneck. Gains accrue to robotics and to upstream scheduling, never to assisting the laborer. |
| **Factory/Machine Operators & Assemblers** | **low–none (assist) / HIGH substitution** | AR-wearable / robotic-embedded | AR guidance error-proofs assembly (real quality lift), but the dominant trajectory is robotic substitution. Inspection (QC) is the standout exception — high fit. |
| **Clerks (office/data-entry/order/general)** | **HIGH** | desktop | The one high-headcount category that is genuinely high assist-fit — and therefore high displacement. Structured language/data/rules at a screen is the textbook agent target. |

**The pattern:** of the ten most-numerous occupations, **nine are low/none assist-fit** and the agent's honest role is voice/mobile relief on a thin admin slice, while the *substitution* story (where it exists) belongs to robotics and kiosks. Only desk clerks are high — confirming that headcount and assist-fit are inversely correlated across the global frontline.

---

## 5. FRONTIER, AI-ERA, AND INFORMAL/GLOBAL ROLES the standard taxonomies miss

SOC/ISCO materially under-represent these — several have **no clean code at all**, which is itself the point: the formal-economy lens erases much of how humanity actually works.

- **Unpaid / household work — the single largest category of human work-hours on Earth, structurally invisible to SOC (counts only paid jobs).**
 - **Family Caregiver / Homemaker** *(medium)* — physical care/supervision of children/elderly/disabled is none-fit; the crushing **admin layer** (appointment scheduling, insurance/benefits navigation, medication tracking, meal/budget planning, eldercare paperwork, coordinating siblings and providers) is HIGH-fit. Arguably the **highest-value positive-sum target on the whole map** precisely because the worker is unpaid, overloaded, and uncounted. Modality: desktop/mobile/voice.
- **AI-era native roles (no clean SOC code):**
 - **Data Labeler / RLHF Rater** *(high)* — automates the very task that trains agents; high fit = existential displacement.
 - **Prompt Engineer / AI-Ops** *(high, self-eroding)* — an agent optimizing agents; the standalone role dissolves into general engineering as models self-tune.
 - **Crypto / DAO Operator** *(high)* — blockchains are machine-readable end-to-end; the wall is custody (no signing keys, irreversible transfer human-gated).
 - **Product Manager, Sales Engineer, RevOps/SDR/Account Executive, Customer Success** *(medium–high)* — CRM-native synthesis, prospecting, sequencing, pipeline; partly already automated.
- **Creator economy:** Streamers, UGC/micro-influencers, OnlyFans creators *(high on ops, none on the persona/body)* — the agent runs the production-and-growth pipeline and the DM sales funnel (an existing human-impersonation labor market it slots into, with sharp consent/disclosure ethics).
- **Gig / solo-operator:** Rideshare/delivery gig drivers *(medium, voice)*, freelancers/indie founders/VAs *(high, desktop)*, resellers/flippers *(medium)*, gig handymen *(low, AR-frontier)*.
- **Informal & global-South frontline (where the majority of the world's workers are):**
 - **Community Health Worker / ASHA / Promotora** *(medium, mobile)* — the standout **positive-sum** case: offline-first, local-language triage protocols, records, scheduling that extend a low-trained worker's clinical reach *without* threatening the in-person trust core. Constraints: connectivity, device cost, clinical liability — not capability.
 - **Smallholder/Subsistence Farmer** *(low, feature-phone voice/IVR)* — a huge share of all humans who work; advisory layer is valuable but gated by feature-phones, power, literacy, and language.
 - **Street Vendor / Market Trader, Mobile-Money Agent** *(low, mobile)* — the selling/cash-counterparty role *is* the job; only a thin back-office surface, on tiny margins.
 - **Domestic Worker, Waste Picker, Brick-Kiln/Informal Construction Laborer** *(none)* — tens of millions each, purely physical, off-grid, often stateless or bonded; effectively zero agent surface. These anchor the floor and correct any residual high-income framing of "the informal economy."
- **Itinerant / dangerous / seasonal class:** wildland firefighters, offshore roustabouts, commercial divers, migrant crew leaders *(mostly low/none)* — where agent value, if any, is **safety/coordination** (crew accountability, hazard alerts, compliance logging), not drafting.

---

## 6. Honest Conclusion: where agent assistance genuinely lands today vs. hype

**Real today:** AI-agent assistance is genuinely transformative for the slice of work that is *structured language, data, and rules executed at a screen* — software, analysis, accounting, legal document production, coding, radiology, medical coding, clerical and administrative work, and the back office of nearly every job (scheduling, compliance paperwork, drafting, reconciliation). For these the agent both assists and, often, *substitutes* — and the most reliable value lever across the physical economy is not clinical or creative genius but the relentless **documentation and compliance burden** that workers already resent. Crucially, the single highest positive-sum target may be the *uncounted* one: the unpaid family caregiver and the offline community health worker, drowning in admin, whom the agent relieves without threatening the human core. **Hype:** the claim that agents will broadly "do" the world's most common jobs. They will not. Of the ten largest occupations on Earth, nine are physical, intimate, or device-hostile, and for them a perceive-and-assist agent reaches — at most — a thin voice or mobile periphery; where disruption is real it comes from *robotics and kiosks that substitute the body*, a different technology on a different timeline, still unsolved for limp fabric, soft tissue, general home cleaning, and most dexterous craft. The honest map is therefore not "every job is great for an AI agent" but a sharply uneven landscape: high fit concentrated in the screen-bound minority of headcount, a vast frontline where the right answer is voice or AR (often not yet ruggedized, often gated by connectivity and language for the global majority), and a substantial floor of work — surgical techs to street vendors to childcare — where the most honest verdict is *none, and durably so*.
