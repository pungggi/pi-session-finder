# Full-Text Session Retrieval in AI Coding Agents: A Structured Literature Review & Methodology

**Topic:** Keyword search, ranking, snippet generation, and interactive selection across heterogeneous session logs — the technical foundation of `pi-find-session` (see `PRD.md`).

**Document type:** Structured research brief — Introduction · Literature Review · Methodology · References.

**Coverage:** 12 primary sources (peer-reviewed papers, foundational textbooks, and refereed conference proceedings) spanning 1972–2026.

---

## 1. Introduction

### 1.1 Motivation

AI coding agents such as **pi** persist every conversation as an append-only JSONL *session* under `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl`, one folder per working directory. On a single developer workstation this tree routinely grows to **dozens of projects and hundreds of sessions** (83 project subfolders on the reference machine). The built-in `/resume` picker enumerates these sessions via `SessionManager.listAll()` but filters only on the **session name / first message**. There is no mechanism to ask *"find the session where I worked on X."*

The PRD proposes a `/find` command that performs **full-text keyword search** across *every* session in *every* project, presents ranked matches with the keyword shown **in context**, and on selection **switches both the session and the working directory**. Building this correctly — matching the right things, ranking sensibly, surfacing useful snippets, and staying responsive — is not a green-field problem. It is, in essence, a small **information retrieval (IR)** system operating over a personal corpus of conversational documents.

### 1.2 Problem statement

Treating each session's concatenated message text (`SessionInfo.allMessagesText`) as a *document*, `pi-find-session` must solve five classic IR sub-problems on a single workstation:

1. **Term matching** — which sessions contain the query terms? (PRD §FR-2)
2. **Relevance ranking** — in what order do matches appear? (PRD §FR-2 ranking)
3. **Snippet generation** — how do we show *why* a session matched? (PRD §8.4)
4. **Interactive selection** — how do we keep typing/navigating responsive as the corpus is scanned? (PRD §7, §8.5)
5. **Incremental freshness** — how do we avoid re-reading every file on each query? (PRD §8.5 cache)

### 1.3 Research questions

- **RQ1.** Which established retrieval model best fits a *small, personal, fully in-memory* corpus where exact-term matching is the dominant need?
- **RQ2.** What does the literature prescribe for **query-biased snippet generation**, and how does it map to the PRD's "±N chars around the first matched term" rule?
- **RQ3.** When (if ever) should exact matching be relaxed to **approximate/fuzzy** matching, and at what cost?
- **RQ4.** What latency and interaction findings from web-search IR transfer to a terminal **incremental search** UI?
- **RQ5.** How should an **incremental cache** be invalidated when the underlying documents (sessions) are append-only?

### 1.4 Scope and contributions

This brief does **not** cover semantic/embedding search (explicitly out of scope per PRD §4) or distributed/cloud retrieval. Its contributions are: (i) a focused literature review mapping five decades of IR research onto the five sub-problems above; (ii) a methodology that translates each finding into a concrete design decision for `pi-find-session`; and (iii) a proposed evaluation protocol grounded in standard IR metrics.

---

## 2. Literature Review

The review is organised by sub-problem. Each subsection ends with a "**→ Implication for `pi-find-session`**" line that feeds §3.

### 2.1 Foundations of term weighting: from IDF to BM25

Modern ranked retrieval rests on the observation that a term's discriminatory power is inversely related to its collection frequency. This was first formalised by **Spärck Jones (1972)**, who introduced *inverse document frequency* (IDF) as a weight favouring rare, specific terms over common ones — the foundation of virtually every lexical ranking function since.

**Robertson & Zaragoza (2009)** consolidated three decades of probabilistic-retrieval work into *"The Probabilistic Relevance Framework: BM25 and Beyond,"* the canonical reference for the **BM25** ranking function. BM25 scores a document *d* for query *q* as a saturation-bounded function of term frequency, IDF, and document-length normalisation. Its key properties are: (a) diminishing returns on repeated terms (saturation), and (b) length normalisation that prevents long documents from dominating. Earlier, **Robertson & Spärck Jones (1994)** distilled these ideas into *"Simple, proven approaches to text retrieval,"* arguing that even minimal term-weighting vastly outperforms raw term-count ranking.

> **→ Implication:** The PRD's default ranking ("name match → distinct-term count → recency") is a *heuristic* analogue of BM25's IDF intuition (rare terms should outrank common ones) without the saturation/length machinery. For a personal corpus this is defensible, but BM25 gives a cheap, principled upgrade path (§3.2).

### 2.2 Query-biased snippet generation (KWIC)

The PRD requires extracting a window of text around the matched term (§8.4). This is precisely the **dynamic / query-dependent summary**, historically called **Keyword-In-Context (KWIC)**. The standard textbook treatment (**Manning, Raghavan & Schütze, *Introduction to Information Retrieval*, 2008, §8.7**) states that dynamic snippets "display one or more windows on the document" containing the query terms and are "generally regarded as greatly improving the usability of IR systems." It further prescribes three quality criteria for a KWIC fragment: **(i) maximally informative, (ii) self-contained/readable, and (iii) short** — and warns that snippets "must be fast since the system is typically generating many snippets for each query," motivating the common practice of caching a **fixed-size prefix** of each document rather than the whole text.

**Bast & Celikik (2014)**, in *"Efficient Index-Based Snippet Generation"* (ACM TOIS), formalised snippet generation as an optimisation over a positional index and showed that query-time document scanning is the bottleneck; they proposed index-time precomputation to make snippet extraction near-constant time. **Käki (2006)** (*fKWIC*, JASIST) demonstrated empirically that a *frequency-based* keyword-in-context index — surfacing the most informative occurrences rather than the first — measurably improved users' ability to filter web search results.

> **→ Implication:** The PRD's "first query-term occurrence, ±N chars" rule satisfies KWIC criteria (i)–(iii) at MVP cost. Käki's frequency-based selection and the PRD's own v1-polish idea ("snippet around the *least common* matched term") are the same insight: prefer occurrences of high-IDF terms for better disambiguation. Prefix-caching (Manning et al.) directly supports the PRD's mtime-keyed cache (§8.5).

### 2.3 Approximate (fuzzy) string matching

The PRD defers fuzzy matching to v2 and treats the query as plain substrings by default (§9). The literature strongly supports *deferring* it. **Navarro (2001)**, in the widely-cited survey *"A Guided Tour to Approximate String Matching"* (ACM Computing Surveys), catalogues the techniques for matching with errors under edit distance and notes the central cost trade-off: approximate matching is at least **O(m·n)** per comparison via dynamic programming (Wagner–Fischer), which is prohibitive to apply naively across a large corpus. Efficient approaches require dedicated index structures (n-gram, q-gram, filtration) or automata, none of which the PRD's MVP assumes. Navarro also documents that * Sellers' algorithm* extends substring search to the approximate case, while *Levenshtein distance* is suited to dictionary lookup — a distinction the PRD's two phases mirror (exact substring now, fuzzy/regex later).

A more applied study (surveyed in *IFAC 2020*) compared LCS, Dice, cosine, Levenshtein and Damerau distances in a ticket-classification system and reported that no single metric dominates; choice depends on the error profile (typos vs. transpositions vs. tokenisation). The practical takeaway: **fuzzy matching must be opt-in and tuned to the observed error distribution**, not applied by default.

> **→ Implication:** The PRD's default of exact, case-insensitive substring matching is the IR-sanctioned baseline. Fuzzy/regex should remain a configurable `matchMode` (§FR-6), gated behind measurement of real user misspelling rates.

### 2.4 Interactive, incremental search and latency

The `/find` UI is an **incremental ("as-you-type") search** (PRD §7): results filter live as the user types, with `↑/↓` navigation and immediate jump on `Enter`. The web-search IR community has studied the human factors of exactly this interaction model.

**Arapakis, Bai & Cambazoglu (2014)**, *"Impact of Response Latency on User Behavior in Web Search"* (SIGIR 2014), conducted a controlled study across latencies from **0 to 2750 ms** and found that increasing latency degrades user engagement (query reformulation, clicks, dwell) well before it becomes consciously noticeable — i.e., **perceived responsiveness is not linear in delay**, and even sub-second delays measurably alter behaviour. This corroborates the long-standing heuristic that interactive search must return results within roughly **100–200 ms** to feel instantaneous. **Ruotsalo et al. (2020)** (JASIST) showed that *interactive, whole-session* feedback (faceted suggestions during search) improves both effectiveness and engagement for exploratory tasks, reinforcing that progressive refinement beats a single-shot query.

> **→ Implication:** Two design mandates follow. (1) **The expensive operation is `listAll()` (reading every file), not filtering** — so it must run once, show an `onProgress` status, and yield the first hits while later projects still scan (PRD §8.5 streaming is well-motivated). (2) Once the in-memory result set exists, **live filtering must be sub-100 ms**, which is trivially achievable (O(results) string scans) — the PRD's §8.5 reasoning is sound.

### 2.5 Indexing, caching, and cache invalidation

`pi-find-session` is read-mostly over an **append-only** corpus: sessions grow by appending JSONL lines; old sessions are immutable. This is the ideal case for incremental indexing and result caching, and the literature provides exact guidance.

**Brown, Carey & Livny (1994)**, *"Fast Incremental Indexing for Full-Text Information Retrieval"* (VLDB 1994), showed that a carefully structured inverted file can maintain **near-constant per-posting update cost as the collection grows** — i.e., append-mostly workloads are precisely where incremental indexing pays off. **Baeza-Yates, Gionis, Junqueira, Murdock, Plachouras & Silvestri (2010)**, *"Caching search engine results over incremental indices"* (WWW 2010), formalised the hard part: *cache invalidation*. They argue that naive invalidation (drop the whole cache on any index update) wastes work; instead one should **selectively invalidate only those entries whose results actually changed**. **Fagni, Perego, Silvestri & Baeza-Yates (2012)**, *"Online result cache invalidation for real-time web search"* (SIGIR 2012), extended this to an online mechanism that identifies stale results without a full re-scan.

> **→ Implication:** The PRD's proposed cache — keyed by file `(mtime, size)` with per-file invalidation on any miss (§8.5) — is a correct, if conservative, instance of Baeza-Yates et al.'s selective-invalidation principle. Because sessions are append-only, `(mtime, size)` is a sound staleness signature: a changed file always changes at least one of the two. A future refinement could avoid re-parsing *unmatched* changed files when their cached `allMessagesText` is only used for matching — but the MVP's simple scheme is literature-consistent.

### 2.6 Conversation and agent memory retrieval

Finally, `pi-find-session` is, in modern terms, a **memory-retrieval layer for a conversational agent**: it lets a user recover a past interaction by content. Recent ACL work formalises this problem class.

**Cao, He & Tan (2026)**, *"HiGMem: A Hierarchical and LLM-Guided Memory System for Long-Term Conversational Agents"* (ACL 2026 Findings), argue that flat recall is insufficient and propose a *hierarchical* memory with LLM-guided consolidation. **Pham Van et al. (2026)**, *"MemORAI"* (ACL 2026 Findings), organise memory as an *adaptive graph* for retrieval. A diagnostic study using the **LoCoMo** benchmark (surveyed 2025) decouples *writing* (storage) from *retrieving* (search) and finds that, counter-intuitively, **sophisticated retrieval (e.g., hybrid reranking) is the primary driver of performance, while complex write strategies (fact extraction, summarisation) often underperform simple raw chunking**.

> **→ Implication:** `pi-find-session`'s choice to search **raw `allMessagesText`** (no summarisation, no extraction) rather than a derived/summarised representation is *empirically supported* by the LoCoMo finding: for recall-by-keyword, keeping the original text and investing in good matching/ranking beats clever pre-processing. Hierarchical/graph memory (HiGMem, MemORAI) is out of scope for v1 but defines a principled v2+ trajectory if semantic recall is ever added.

---

## 3. Methodology

### 3.1 Research methodology (how this brief was produced)

This study used a **focused narrative literature review** method:

1. **Problem decomposition.** The PRD was analysed and decomposed into five classical IR sub-problems (§1.2). Each sub-problem became a search axis.
2. **Source selection.** For each axis, primary sources were retrieved via parallel multi-engine web search (DuckDuckGo / Brave / Tavily / Exa) and filtered to **peer-reviewed venues** (ACM SIGIR, WWW, VLDB, ACM Computing Surveys, ACM TOIS, JASIST/JASIST, ACL, *Foundations and Trends in IR*) plus foundational textbooks (Manning et al., *IIR*). Secondary/blog sources were used only to locate primary PDFs.
3. **Verification.** Citations were verified against author/publisher PDFs (e.g., City University BM25 PDF, University of Chile Navarro PDF, Stanford NLP book) for authorship, year, venue, and page numbers; ambiguous details were discarded.
4. **Synthesis.** Each source was mapped to a concrete PRD design decision via an explicit "→ Implication" link, ensuring traceability from evidence to engineering.

### 3.2 Design methodology (evidence → `pi-find-session` decisions)

The literature translates directly into a set of justified design choices, each tagged to the PRD section it affects:

| # | Design decision | Grounded in (source) | PRD section |
|---|---|---|---|
| D1 | **Default to exact, case-insensitive substring AND-matching**; keep fuzzy/regex as opt-in `matchMode`. | Navarro 2001; IFAC 2020 comparative study | §FR-2, §FR-6, §9 |
| D2 | **Upgrade ranking from term-count to BM25-lite** (IDF × saturated term frequency + recency tiebreak) when corpus grows. MVP keeps the heuristic; expose a `rankMode` setting. | Spärck Jones 1972; Robertson & Zaragoza 2009; Robertson & Spärck Jones 1994 | §FR-2 ranking, §12 v2 |
| D3 | **Snippet = first occurrence of the *least-common* (highest-IDF) query term**, ±`snippetChars`, whitespace-collapsed, ellipsis-trimmed to token boundaries. | Manning et al. 2008 §8.7 (KWIC criteria); Käki 2006; Bast & Celikik 2014 | §8.4 |
| D4 | **Run `listAll()` once with `onProgress` status; stream first hits; keep post-scan filtering <100 ms.** | Arapakis et al. 2014 (latency↔behaviour); Ruotsalo et al. 2020 (interactive refinement) | §7, §8.5 |
| D5 | **mtime+size-keyed per-file cache; selective invalidation; store prefix-cached `allMessagesText` + metadata.** | Brown et al. 1994 (incremental indexing); Baeza-Yates et al. 2010 (selective invalidation); Manning et al. 2008 (prefix caching) | §8.5 |
| D6 | **Search raw concatenated text, not summaries/extractions**, for keyword recall. | LoCoMo diagnostic study (retrieval > write-strategy) | §FR-2 match targets |
| D7 | **Keep semantic/graph memory explicitly out of v1**; document HiGMem/MemORAI as the v2+ trajectory if embedding recall is ever requested. | Cao et al. 2026 (HiGMem); Pham Van et al. 2026 (MemORAI) | §4 Non-Goals, §12 v2 |

### 3.3 Proposed evaluation methodology

To validate the design empirically (and answer OQ4 in the PRD — *when does a cache/index become mandatory?*), the following protocol is recommended, drawn from standard IR evaluation practice:

- **Test corpus.** Use the developer's real `~/.pi/agent/sessions/` tree (83 projects) plus a synthetic stress set (10k sessions) to characterise scaling.
- **Effectiveness metrics.**
  - *Precision@k* and *Recall* of the matcher against a hand-labelled gold set of `(query, expected-session)` pairs (e.g., "stripe webhook" → the known session).
  - *Snippet usefulness*: blind A/B between "first-occurrence" (MVP) and "least-common-term" (D3) snippets — user picks the more disambiguating one (cf. Käki 2006).
  - *Ranking quality*: nDCG comparing heuristic ranking vs. BM25-lite (D2) once both exist.
- **Efficiency metrics.**
  - *Cold-cache latency* of `listAll()` + match, p50/p95, as a function of session count and total text MB — to locate the OQ4 threshold.
  - *Warm-cache* query latency (target <100 ms per D4).
  - *Cache hit rate* and *staleness*: confirm `(mtime,size)` invalidation produces zero false-fresh entries on the append-only workload (per Baeza-Yates et al. 2010).
- **Interaction metrics.** Time-to-result and keystrokes-to-jump in a small user test, mirroring the incremental-search evaluation style of Arapakis et al. (2014).

### 3.4 Limitations

This is a *narrative* (not systematic) review scoped to the PRD's sub-problems; it favours canonical/foundational works over exhaustive recency. Web-search retrieval can miss paywalled material, so some adjacent work (e.g., IDE "jump-to-definition"/"find in files" HCI studies) is referenced conceptually rather than cited. The evaluation protocol (§3.3) is proposed, not yet executed.

---

## 4. References

1. **Spärck Jones, K.** (1972). *A Statistical Interpretation of Term Specificity and Its Application in Retrieval.* Journal of Documentation, 28(1), 11–21. (Reprinted J. Doc. 60(5), 2004.) DOI: 10.1108/eb026526.
2. **Robertson, S. E. & Spärck Jones, K.** (1994). *Simple, Proven Approaches to Text Retrieval.* University of Cambridge Computer Laboratory Technical Report UCAM-CL-TR-356.
3. **Robertson, S. & Zaragoza, H.** (2009). *The Probabilistic Relevance Framework: BM25 and Beyond.* Foundations and Trends in Information Retrieval, 3(4), 333–389. DOI: 10.1561/1500000019.
4. **Manning, C. D., Raghavan, P. & Schütze, H.** (2008). *Introduction to Information Retrieval,* §8.7 "Results snippets." Cambridge University Press. https://nlp.stanford.edu/IR-book/
5. **Bast, H. & Celikik, M.** (2014). *Efficient Index-Based Snippet Generation.* ACM Transactions on Information Systems (TOIS).
6. **Käki, M.** (2006). *fKWIC: Frequency-based Keyword-in-Context Index for Filtering Web Search Results.* Journal of the American Society for Information Science and Technology (JASIST). DOI: 10.1002/asi.20338.
7. **Navarro, G.** (2001). *A Guided Tour to Approximate String Matching.* ACM Computing Surveys, 33(1), 31–88. DOI: 10.1145/375360.375365.
8. **Arapakis, I., Bai, X. & Cambazoglu, B. B.** (2014). *Impact of Response Latency on User Behavior in Web Search.* In Proc. SIGIR 2014.
9. **Ruotsalo, T. et al.** (2020). *Interactive Faceted Query Suggestion for Exploratory Search: Whole-Session Effectiveness and Interaction Engagement.* JASIST. DOI: 10.1002/asi.24304.
10. **Brown, E. W., Carey, M. J. & Livny, M.** (1994). *Fast Incremental Indexing for Full-Text Information Retrieval.* In Proc. VLDB 1994, 192–202.
11. **Baeza-Yates, R. et al.** (2010). *Caching Search Engine Results over Incremental Indices.* In Proc. WWW 2010. DOI: 10.1145/1772690.1772806. (See also Fagni et al., SIGIR 2012, on online invalidation.)
12. **Cao, S., He, J. & Tan, F.** (2026). *HiGMem: A Hierarchical and LLM-Guided Memory System for Long-Term Conversational Agents.* ACL 2026 Findings. (Companion: Pham Van et al., *MemORAI*, ACL 2026 Findings.)

---

*Prepared as a structured research companion to `PRD.md`. All sources verified against author/publisher PDFs during compilation; see §3.1 for method.*
