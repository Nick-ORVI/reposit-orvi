/* Reposit-ORVI — client-side QCEW subset builder.
 * Loads per-state files from data/<series>/<fips>.csv.gz on demand, filters them
 * in the browser and writes the result as a CSV download. No server needed. */
(() => {
  "use strict";

  const ORVI_REGION = ["39000", "42000", "54000", "21000"]; // OH, PA, WV, KY
  const PREVIEW_ROWS = 100;
  const LARGE_ROWS = 1500000;

  // Friendlier names for BLS aggregation levels
  const LEVEL_NAMES = {
    "50": "All industries (total)", "51": "All industries, by ownership", "52": "Domain (goods / services)",
    "53": "Supersector", "54": "NAICS sector (2-digit)", "55": "NAICS 3-digit", "56": "NAICS 4-digit",
    "57": "NAICS 5-digit", "58": "NAICS 6-digit",
    "18": "All industries (total)", "19": "All industries, by ownership", "20": "SIC division",
    "21": "SIC 2-digit", "22": "SIC 3-digit", "23": "SIC 4-digit",
  };
  const LEVEL_SHORT = {
    "50": "Total", "51": "Total", "52": "Domain", "53": "Supersector", "54": "Sector", "55": "3-digit",
    "56": "4-digit", "57": "5-digit", "58": "6-digit", "18": "Total", "19": "Total", "20": "Division",
    "21": "2-digit", "22": "3-digit", "23": "4-digit",
  };
  const DEFAULT_LEVELS = { naics: ["50", "54"], sic: ["18", "20"] };

  // Measures: key in data file -> output column (BLS names) and label
  const MEASURES = [
    { key: "emp", col: "annual_avg_emplvl", label: "Employment (annual average)", on: true },
    { key: "estabs", col: "annual_avg_estabs_count", label: "Establishments", on: true, keepWhenSuppressed: true },
    { key: "wages", col: "total_annual_wages", label: "Total wages ($)", on: true },
    { key: "avg_pay", col: "avg_annual_pay", label: "Average annual pay ($)", on: true },
    { key: "wkly_wage", col: "annual_avg_wkly_wage", label: "Average weekly wage ($)", on: false },
    { key: "tax_wages", col: "taxable_annual_wages", label: "Taxable wages ($)", on: false },
    { key: "contrib", col: "annual_contributions", label: "UI contributions ($)", on: false },
  ];

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) n.append(k);
    return n;
  };
  const fmt = new Intl.NumberFormat("en-US");

  let M = null;               // manifest
  const S = {                 // UI state
    series: "naics", states: new Set(ORVI_REGION), yFrom: 0, yTo: 0,
    levels: new Set(), owns: new Set(["0", "5"]), inds: new Set(), children: true,
    measures: new Set(MEASURES.filter((m) => m.on).map((m) => m.key)), labels: true, drop: false,
  };
  const cache = new Map();    // "series/fips" -> Promise<parsed state>
  let lookups = {};           // per-series lookup tables
  let result = null;          // last filter result
  let runToken = 0;

  // ---------- Data loading ----------
  async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // Some servers decompress .gz transparently; only gunzip if the gzip magic bytes are present
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      return await new Response(stream).text();
    }
    return new TextDecoder().decode(buf);
  }

  function parseState(text, L) {
    const lines = text.split("\n");
    const head = lines[0].trim().split(",");
    const idx = Object.fromEntries(head.map((h, i) => [h, i]));
    let n = lines.length - 1;
    while (n > 0 && !lines[n].trim()) n--;
    const d = {
      n, year: new Uint16Array(n), own: new Uint8Array(n), lvl: new Uint8Array(n),
      ind: new Uint32Array(n), sup: new Uint8Array(n), m: {},
    };
    for (const m of MEASURES) d.m[m.key] = new Float64Array(n);
    for (let r = 0; r < n; r++) {
      const f = lines[r + 1].split(",");
      d.year[r] = +f[idx.year];
      d.own[r] = +f[idx.own];
      d.lvl[r] = +f[idx.lvl];
      const code = f[idx.ind];
      let ii = L.indIndex.get(code);
      if (ii === undefined) { ii = L.inds.length; L.inds.push({ code, title: "", lvl: f[idx.lvl] }); L.indIndex.set(code, ii); }
      d.ind[r] = ii;
      d.sup[r] = f[idx.disc].replace(/"/g, "") === "N" ? 1 : 0;
      for (const m of MEASURES) { const v = f[idx[m.key]]; d.m[m.key][r] = v === "" || v === undefined ? NaN : +v; }
    }
    return d;
  }

  function loadState(series, fips) {
    const key = `${series}/${fips}`;
    if (!cache.has(key)) {
      const p = fetchText(`data/${series}/${fips}.csv.gz`).then((t) => parseState(t, lookups[series]));
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return cache.get(key);
  }

  async function loadMany(series, fipsList, onProgress) {
    const out = new Map();
    let done = 0;
    const queue = [...fipsList];
    const worker = async () => {
      while (queue.length) {
        const f = queue.shift();
        out.set(f, await loadState(series, f));
        onProgress(++done, fipsList.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
    return out;
  }

  // ---------- Filtering ----------
  function industryMask(L) {
    if (!S.inds.size) return null;
    const prefixes = [];
    for (const code of S.inds) {
      const m = code.match(/^(\d+)-(\d+)$/); // NAICS ranges like 31-33
      if (m) for (let k = +m[1]; k <= +m[2]; k++) prefixes.push(String(k));
      prefixes.push(code);
    }
    const mask = new Uint8Array(L.inds.length);
    L.inds.forEach((it, i) => {
      if (S.inds.has(it.code)) mask[i] = 1;
      else if (S.children && prefixes.some((p) => it.code.length > p.length && it.code.startsWith(p))) mask[i] = 1;
    });
    return mask;
  }

  function filter(data) {
    const L = lookups[S.series];
    const lvlOk = new Uint8Array(256); S.levels.forEach((c) => (lvlOk[+c] = 1));
    const ownOk = new Uint8Array(16); S.owns.forEach((c) => (ownOk[+c] = 1));
    const indOk = industryMask(L);
    const parts = [];
    let total = 0, suppressed = 0;
    const statesSorted = [...data.keys()].sort((a, b) => L.stateName[a].localeCompare(L.stateName[b]));
    for (const fips of statesSorted) {
      const d = data.get(fips);
      const hits = new Int32Array(d.n);
      let k = 0;
      for (let r = 0; r < d.n; r++) {
        const y = d.year[r];
        if (y < S.yFrom || y > S.yTo || !lvlOk[d.lvl[r]] || !ownOk[d.own[r]]) continue;
        if (indOk && !indOk[d.ind[r]]) continue;
        if (d.sup[r]) { if (S.drop) continue; suppressed++; }
        hits[k++] = r;
      }
      if (k) parts.push({ fips, d, rows: hits.subarray(0, k) });
      total += k;
    }
    return { parts, total, suppressed };
  }

  // ---------- Output ----------
  function columns() {
    const cols = S.labels
      ? ["state_fips", "state", "year", "own_code", "ownership", "agglvl_code", "industry_level", "industry_code", "industry_title", "suppressed"]
      : ["state_fips", "year", "own_code", "agglvl_code", "industry_code", "suppressed"];
    return cols.concat(MEASURES.filter((m) => S.measures.has(m.key)).map((m) => m.col));
  }

  const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

  function rowValues(fips, d, r) {
    const L = lookups[S.series];
    const it = L.inds[d.ind[r]];
    const own = String(d.own[r]), lvl = String(d.lvl[r]);
    const sup = d.sup[r] === 1;
    const vals = S.labels
      ? [fips, L.stateName[fips], String(d.year[r]), own, L.ownName[own] || "", lvl, LEVEL_NAMES[lvl] || "", it.code, it.title, sup ? "TRUE" : "FALSE"]
      : [fips, String(d.year[r]), own, lvl, it.code, sup ? "TRUE" : "FALSE"];
    for (const m of MEASURES) {
      if (!S.measures.has(m.key)) continue;
      const v = d.m[m.key][r];
      vals.push(Number.isNaN(v) || (sup && !m.keepWhenSuppressed) ? "" : v);
    }
    return vals;
  }

  function buildCsvBlob(res) {
    const chunks = [columns().join(",") + "\n"];
    let buf = [];
    for (const p of res.parts) {
      for (const r of p.rows) {
        buf.push(rowValues(p.fips, p.d, r).map((v) => q(String(v))).join(","));
        if (buf.length === 20000) { chunks.push(buf.join("\n") + "\n"); buf = []; }
      }
    }
    if (buf.length) chunks.push(buf.join("\n") + "\n");
    return new Blob(chunks, { type: "text/csv" });
  }

  function fileName() {
    const n = S.states.size;
    const st = n === 1 ? lookups[S.series].stateAbbr([...S.states][0]) : n === ORVI_REGION.length && ORVI_REGION.every((f) => S.states.has(f)) ? "orvi-region" : `${n}-states`;
    const yrs = S.yFrom === S.yTo ? S.yFrom : `${S.yFrom}-${S.yTo}`;
    return `reposit-orvi_qcew_${S.series}_${st}_${yrs}.csv`;
  }

  // ---------- Rendering ----------
  function renderPreview(res) {
    const thead = $("#preview thead"), tbody = $("#preview tbody");
    const cols = columns();
    thead.replaceChildren(el("tr", {}, ...cols.map((c) => el("th", { textContent: c }))));
    const frag = document.createDocumentFragment();
    let shown = 0;
    outer: for (const p of res.parts) {
      for (const r of p.rows) {
        const vals = rowValues(p.fips, p.d, r);
        frag.append(el("tr", {}, ...vals.map((v, i) => {
          const numeric = typeof v === "number";
          const td = el("td", { textContent: numeric ? fmt.format(v) : v });
          if (numeric) td.className = "num";
          if (cols[i] === "suppressed" && v === "TRUE") td.className = "sup";
          return td;
        })));
        if (++shown >= PREVIEW_ROWS) break outer;
      }
    }
    tbody.replaceChildren(frag);
    $("#preview-note").textContent = res.total > PREVIEW_ROWS ? `Showing the first ${PREVIEW_ROWS} of ${fmt.format(res.total)} rows. The download includes all of them.` : "";
  }

  function setStatus(html, cls = "") {
    const s = $("#status");
    s.className = "status " + cls;
    s.innerHTML = html;
  }

  function summaryText() {
    const L = lookups[S.series];
    const levels = [...S.levels].sort().map((c) => LEVEL_SHORT[c]).filter((v, i, a) => a.indexOf(v) === i);
    const owns = [...S.owns].sort().map((c) => L.ownName[c]).filter(Boolean);
    const inds = S.inds.size ? `${S.inds.size} selected industr${S.inds.size === 1 ? "y" : "ies"}${S.children ? " (with sub-industries)" : ""}` : "all industries";
    const st = S.states.size <= 4 ? [...S.states].map((f) => L.stateName[f]).sort().join(", ") : `${S.states.size} states`;
    return `${M.series[S.series].label.split(" ")[0]} · ${st} · ${S.yFrom}–${S.yTo} · ${levels.join(", ") || "no levels"} · ${owns.join(", ") || "no ownership"} · ${inds}`;
  }

  async function run() {
    const token = ++runToken;
    $("#download").disabled = true;
    $("#summary").textContent = summaryText();
    const problems = [];
    if (!S.states.size) problems.push("a state");
    if (!S.levels.size) problems.push("an industry detail level");
    if (!S.owns.size) problems.push("an ownership type");
    if (problems.length) {
      result = null;
      $("#row-count").textContent = "0";
      $("#preview tbody").replaceChildren();
      $("#preview-note").textContent = "";
      setStatus(`Select at least ${problems.join(", ")} to build a dataset.`, "warn");
      return;
    }
    const needed = [...S.states];
    const pending = needed.filter((f) => !cache.has(`${S.series}/${f}`));
    if (pending.length) setStatus(`Loading ${pending.length} state file${pending.length > 1 ? "s" : ""}…<div class="bar"><i style="width:0%"></i></div>`);
    let data;
    try {
      data = await loadMany(S.series, needed, (done, n) => {
        if (token !== runToken || !pending.length) return;
        const bar = $("#status .bar i");
        if (bar) bar.style.width = `${Math.round((done / n) * 100)}%`;
      });
    } catch (e) {
      if (token === runToken) setStatus(`Could not load data: ${e.message}`, "warn");
      return;
    }
    if (token !== runToken) return;
    result = filter(data);
    $("#row-count").textContent = fmt.format(result.total);
    renderPreview(result);
    const notes = [];
    if (result.suppressed) notes.push(`${fmt.format(result.suppressed)} rows are suppressed by BLS (values left blank).`);
    if (S.owns.size === 1 && S.owns.has("0") && [...S.levels].some((l) => !["50", "18"].includes(l))) notes.push("Total covered is only published for the all-industries total. Industry detail is broken out by ownership, so choose Private for most industry analysis.");
    if (result.total > LARGE_ROWS) notes.push(`This is a large file. Building the download may take a minute and use a lot of memory.`);
    if (!result.total) notes.push("No rows match these filters.");
    setStatus(notes.join(" "), result.total > LARGE_ROWS || !result.total ? "warn" : "");
    $("#download").disabled = !result.total;
  }

  let timer;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 150); };

  // ---------- Controls ----------
  function checkbox(value, checked, label, onChange, extra) {
    const input = el("input", { type: "checkbox", value, checked });
    input.addEventListener("change", () => onChange(input.checked, value));
    const lab = el("label", { className: "check" }, input);
    if (extra?.code) lab.append(el("span", { className: "code", textContent: extra.code }));
    lab.append(el("span", { textContent: label }));
    if (extra?.lvl) lab.append(el("span", { className: "lvl", textContent: extra.lvl }));
    return lab;
  }
  const toggler = (set) => (on, v) => { on ? set.add(v) : set.delete(v); schedule(); };

  function renderSeries() {
    const box = $("#series");
    box.replaceChildren(...Object.entries(M.series).map(([key, s]) => {
      const input = el("input", { type: "radio", name: "series", value: key, checked: key === S.series });
      input.addEventListener("change", () => switchSeries(key));
      return el("label", {}, input, s.label);
    }));
    const s = M.series[S.series];
    $("#series-note").textContent = `${s.note}, ${s.years[0]}–${s.years[1]}.`;
  }

  function renderStates() {
    const L = lookups[S.series];
    const term = $("#state-search").value.trim().toLowerCase();
    const list = M.series[S.series].states.filter((s) => !term || s.name.toLowerCase().includes(term));
    $("#state-list").replaceChildren(...list.map((s) => checkbox(s.fips, S.states.has(s.fips), s.name, (on, v) => {
      on ? S.states.add(v) : S.states.delete(v);
      $("#state-count").textContent = S.states.size;
      schedule();
    })));
    $("#state-count").textContent = S.states.size;
    void L;
  }

  function renderYears() {
    const [a, b] = M.series[S.series].years;
    const opts = () => Array.from({ length: b - a + 1 }, (_, i) => el("option", { value: a + i, textContent: a + i }));
    const from = $("#year-from"), to = $("#year-to");
    from.replaceChildren(...opts()); to.replaceChildren(...opts());
    S.yFrom = Math.max(a, Math.min(S.yFrom || a, b)); S.yTo = Math.min(b, Math.max(S.yTo || b, a));
    if (S.yFrom > S.yTo) [S.yFrom, S.yTo] = [a, b];
    from.value = S.yFrom; to.value = S.yTo;
  }

  function renderLevels() {
    $("#level-list").replaceChildren(...M.series[S.series].levels.map((l) =>
      checkbox(l.code, S.levels.has(l.code), LEVEL_NAMES[l.code] || l.title, toggler(S.levels))));
  }

  function renderOwnership() {
    $("#own-list").replaceChildren(...M.series[S.series].ownership.map((o) =>
      checkbox(o.code, S.owns.has(o.code), o.code === "0" ? "Total covered (all employers)" : o.title, toggler(S.owns))));
  }

  function renderMeasures() {
    $("#measure-list").replaceChildren(...MEASURES.map((m) => checkbox(m.key, S.measures.has(m.key), m.label, toggler(S.measures))));
  }

  function renderIndustrySearch() {
    const L = lookups[S.series];
    const term = $("#ind-search").value.trim().toLowerCase();
    const box = $("#ind-results");
    if (!term) { box.replaceChildren(); return; }
    const matches = [];
    for (const it of L.inds) {
      if (!it.title) continue;
      const code = it.code.toLowerCase();
      const score = code === term ? 0 : code.startsWith(term) ? 1 : it.title.toLowerCase().includes(term) ? 2 : -1;
      if (score >= 0) matches.push([score, it]);
    }
    matches.sort((a, b) => a[0] - b[0] || a[1].lvl.localeCompare(b[1].lvl) || a[1].code.localeCompare(b[1].code));
    const shown = matches.slice(0, 150);
    box.replaceChildren(...(shown.length ? shown.map(([, it]) =>
      checkbox(it.code, S.inds.has(it.code), it.title, (on, v) => { on ? S.inds.add(v) : S.inds.delete(v); renderChips(); schedule(); },
        { code: it.code, lvl: LEVEL_SHORT[it.lvl] || "" }))
      : [el("div", { className: "empty", textContent: "No matching industries." })]));
    if (matches.length > shown.length) box.append(el("div", { className: "empty", textContent: `${matches.length - shown.length} more. Refine your search.` }));
  }

  function renderChips() {
    const L = lookups[S.series];
    $("#ind-chips").replaceChildren(...[...S.inds].map((code) => {
      const it = L.inds[L.indIndex.get(code)];
      const btn = el("button", { type: "button", title: "Remove", textContent: "×" });
      btn.setAttribute("aria-label", `Remove ${it?.title || code}`);
      btn.addEventListener("click", () => { S.inds.delete(code); renderChips(); renderIndustrySearch(); schedule(); });
      return el("span", { className: "chip" }, el("span", { textContent: `${code} ${it?.title || ""}` }), btn);
    }));
  }

  function switchSeries(key) {
    S.series = key;
    S.levels = new Set(DEFAULT_LEVELS[key]);
    S.inds.clear();
    const valid = new Set(M.series[key].states.map((s) => s.fips));
    S.states = new Set([...S.states].filter((f) => valid.has(f)));
    const [a, b] = M.series[key].years;
    S.yFrom = a; S.yTo = b;
    renderAll();
    schedule();
  }

  function renderAll() {
    renderSeries(); renderStates(); renderYears(); renderLevels(); renderOwnership();
    renderMeasures(); renderChips(); renderIndustrySearch();
    $("#opt-labels").checked = S.labels;
    $("#opt-drop-suppressed").checked = S.drop;
    $("#ind-children").checked = S.children;
  }

  function buildLookups() {
    const abbr = { "39000": "OH", "42000": "PA", "54000": "WV", "21000": "KY" };
    for (const [key, s] of Object.entries(M.series)) {
      const inds = s.industries.map((it) => ({ ...it }));
      lookups[key] = {
        inds,
        indIndex: new Map(inds.map((it, i) => [it.code, i])),
        stateName: Object.fromEntries(s.states.map((x) => [x.fips, x.name])),
        ownName: Object.fromEntries(s.ownership.map((o) => [o.code, o.title])),
        stateAbbr: (f) => abbr[f] || s.states.find((x) => x.fips === f).name.toLowerCase().replace(/[^a-z]+/g, "-"),
      };
    }
  }

  function wire() {
    $("#state-search").addEventListener("input", renderStates);
    document.querySelectorAll("[data-states]").forEach((b) => b.addEventListener("click", () => {
      const all = M.series[S.series].states.map((s) => s.fips);
      const mode = b.dataset.states;
      S.states = new Set(mode === "all" ? all : mode === "orvi" ? ORVI_REGION.filter((f) => all.includes(f)) : []);
      renderStates(); schedule();
    }));
    $("#year-from").addEventListener("change", (e) => { S.yFrom = +e.target.value; if (S.yFrom > S.yTo) { S.yTo = S.yFrom; $("#year-to").value = S.yTo; } schedule(); });
    $("#year-to").addEventListener("change", (e) => { S.yTo = +e.target.value; if (S.yTo < S.yFrom) { S.yFrom = S.yTo; $("#year-from").value = S.yFrom; } schedule(); });
    $("#ind-search").addEventListener("input", renderIndustrySearch);
    $("#ind-children").addEventListener("change", (e) => { S.children = e.target.checked; schedule(); });
    $("#opt-labels").addEventListener("change", (e) => { S.labels = e.target.checked; schedule(); });
    $("#opt-drop-suppressed").addEventListener("change", (e) => { S.drop = e.target.checked; schedule(); });
    $("#download").addEventListener("click", async () => {
      if (!result?.total) return;
      const btn = $("#download");
      btn.disabled = true;
      setStatus("Building CSV…");
      await new Promise((r) => setTimeout(r, 30));
      const blob = buildCsvBlob(result);
      const url = URL.createObjectURL(blob);
      const a = el("a", { href: url, download: fileName() });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setStatus(`Downloaded ${fileName()} (${(blob.size / 1048576).toFixed(1)} MB, ${fmt.format(result.total)} rows).`);
      btn.disabled = false;
    });
  }

  async function init() {
    try {
      M = await (await fetch("data/manifest.json")).json();
    } catch (e) {
      setStatus("Could not load data/manifest.json. If you opened this file directly, serve the folder over HTTP instead.", "warn");
      return;
    }
    buildLookups();
    S.levels = new Set(DEFAULT_LEVELS[S.series]);
    const [a, b] = M.series[S.series].years;
    S.yFrom = a; S.yTo = b;
    $("#build-info").textContent = `Data built ${M.generated} from BLS QCEW annual files.`;
    wire();
    renderAll();
    run();
  }

  init();
})();
