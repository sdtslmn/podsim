// The Visualizer tab: nodes with their Pods, and the network (Ingress,
// Services, Pods, NetworkPolicies) with live traffic. It reads the cluster
// through clusterView() and trafficEvents() and never changes anything.

import { clusterView, trafficEvents, type Cluster, type ClusterView, type PodView, type TrafficEvent } from "@podsim/core";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const STATE_LABEL: Record<string, string> = {
  running: "Running",
  notready: "Not ready",
  pending: "Starting",
  failed: "Failing",
  done: "Completed",
  terminating: "Terminating",
};

type Box = { x: number; y: number; w: number; h: number };

export class Visualizer {
  view: "nodes" | "network" = "nodes";
  /** "" means all namespaces (except system ones unless shown). */
  namespace = "";
  system = false;
  selectedPod?: string;
  selectedPolicy?: string;
  private el?: HTMLElement;
  private timer?: ReturnType<typeof setInterval>;
  private seen = new Set<string>();
  private ghosts = new Map<string, { pod: PodView; until: number }>();
  private lastPods = new Map<string, PodView>();
  private signature = "";
  private lastSeq = 0;
  private boxes = new Map<string, Box>();
  private clusterRef?: Cluster;

  constructor(
    private getCluster: () => Cluster | undefined,
    private currentNamespace: () => string,
  ) {}

  mount(el: HTMLElement): void {
    this.el = el;
    this.signature = "";
    el.innerHTML = `<div class="viz">
      <div class="viz-head">
        <div class="tabs small">
          <button class="tab${this.view === "nodes" ? " active" : ""}" data-viz="nodes">Nodes</button>
          <button class="tab${this.view === "network" ? " active" : ""}" data-viz="network">Network</button>
        </div>
        <select id="viz-ns" aria-label="Namespace"></select>
        <label class="meta"><input type="checkbox" id="viz-sys"${this.system ? " checked" : ""}> system Pods</label>
      </div>
      <div id="viz-body"></div>
      <div id="viz-detail"></div>
      <div class="viz-legend">${Object.entries(STATE_LABEL)
        .map(([k, v]) => `<span><i class="dot s-${k}"></i>${v}</span>`)
        .join("")}<span><i class="shield-mini"></i>NetworkPolicy</span></div>
    </div>`;
    el.querySelectorAll<HTMLButtonElement>("[data-viz]").forEach((b) =>
      b.addEventListener("click", () => {
        this.view = b.dataset.viz as "nodes" | "network";
        el.querySelectorAll("[data-viz]").forEach((x) => x.classList.toggle("active", x === b));
        if (this.view === "network" && !this.namespace) this.namespace = this.currentNamespace();
        this.signature = "";
        this.refresh();
      }),
    );
    el.querySelector<HTMLSelectElement>("#viz-ns")!.addEventListener("change", (e) => {
      this.namespace = (e.target as HTMLSelectElement).value;
      this.selectedPolicy = undefined;
      this.signature = "";
      this.refresh();
    });
    el.querySelector<HTMLInputElement>("#viz-sys")!.addEventListener("change", (e) => {
      this.system = (e.target as HTMLInputElement).checked;
      this.signature = "";
      this.refresh();
    });
    this.refresh();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const c = this.getCluster();
      if (!c || !this.el?.isConnected) return this.unmount();
      c.advance();
      this.refresh();
    }, 1000);
  }

  unmount(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.el = undefined;
  }

  get mounted(): boolean {
    return !!this.el?.isConnected;
  }

  /** Redraw if anything changed, and animate new traffic. */
  refresh(): void {
    const cluster = this.getCluster();
    if (!this.el || !cluster) return;
    if (cluster !== this.clusterRef) {
      // A new lab or sandbox: start fresh.
      this.clusterRef = cluster;
      this.seen.clear();
      this.ghosts.clear();
      this.lastPods.clear();
      this.selectedPod = undefined;
      this.selectedPolicy = undefined;
      this.lastSeq = trafficEvents(cluster).at(-1)?.seq ?? 0;
      this.signature = "";
    }
    const v = clusterView(cluster, { namespace: this.namespace || undefined, system: this.system });
    if (this.namespace && !v.namespaces.includes(this.namespace)) this.namespace = "";
    this.trackGhosts(v);
    const sel = this.el.querySelector<HTMLSelectElement>("#viz-ns")!;
    const opts = `<option value="">All namespaces</option>${v.namespaces.map((n) => `<option value="${esc(n)}"${n === this.namespace ? " selected" : ""}>${esc(n)}</option>`).join("")}`;
    if (sel.innerHTML !== opts) sel.innerHTML = opts;
    const sig = JSON.stringify([this.view, this.namespace, this.system, this.selectedPod, this.selectedPolicy, v, [...this.ghosts.keys()]]);
    if (sig !== this.signature) {
      this.signature = sig;
      const body = this.el.querySelector<HTMLElement>("#viz-body")!;
      body.innerHTML = this.view === "nodes" ? this.nodesHtml(v) : this.networkHtml(v);
      this.wire(body);
      this.renderDetail(v);
      for (const p of v.pods) this.seen.add(p.uid);
    }
    if (this.view === "network") this.animate(cluster);
    else this.lastSeq = trafficEvents(cluster).at(-1)?.seq ?? this.lastSeq;
  }

  private trackGhosts(v: ClusterView): void {
    const now = Date.now();
    const current = new Map(v.pods.map((p) => [p.uid, p]));
    for (const [uid, p] of this.lastPods) if (!current.has(uid) && this.seen.has(uid)) this.ghosts.set(uid, { pod: { ...p, state: "terminating" }, until: now + 1500 });
    for (const [uid, g] of this.ghosts) if (g.until < now || current.has(uid)) this.ghosts.delete(uid);
    this.lastPods = current;
  }

  private chip(p: PodView, extra = ""): string {
    const fresh = this.seen.size > 0 && !this.seen.has(p.uid) ? " new" : "";
    const short = p.name.replace(/-([a-z0-9]{8,10})-([a-z0-9]{5})$/, "-…-$2");
    return `<button class="pod s-${p.state}${fresh}${extra}${this.selectedPod === p.uid ? " sel" : ""}" data-pod="${esc(p.uid)}" title="${esc(`${p.ns}/${p.name}: ${p.status}`)}">
      <i class="dot s-${p.state}"></i><span>${esc(short)}</span>${p.restarts ? `<b class="restarts">↻${p.restarts}</b>` : ""}${p.ingressPolicy || p.egressPolicy ? `<i class="shield-mini" title="Selected by a NetworkPolicy"></i>` : ""}
    </button>`;
  }

  private groups(pods: PodView[], showNs: boolean): string {
    const by = new Map<string, PodView[]>();
    for (const p of pods) {
      const key = `${showNs ? `${p.ns} · ` : ""}${p.owner ? `${p.owner.kind} ${p.owner.name}` : "Pod (no controller)"}`;
      by.set(key, [...(by.get(key) ?? []), p]);
    }
    return [...by]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, list]) => `<div class="group"><div class="group-title">${esc(k)}</div><div class="pods">${list.map((p) => this.chip(p, this.ghosts.has(p.uid) ? " gone" : "")).join("")}</div></div>`)
      .join("");
  }

  private nodesHtml(v: ClusterView): string {
    const pods = [...v.pods, ...[...this.ghosts.values()].map((g) => g.pod)];
    const showNs = !this.namespace && new Set(pods.map((p) => p.ns)).size > 1;
    const bar = (label: string, pct: number) => `<span class="meta">${label}</span><span class="progress${pct > 90 ? " hot" : ""}"><span style="width:${Math.min(100, pct)}%"></span></span><span class="meta">${pct}%</span>`;
    const cards = v.nodes.map((n) => {
      const mine = pods.filter((p) => p.node === n.name && p.state !== "done");
      const done = pods.filter((p) => p.node === n.name && p.state === "done").length;
      return `<div class="node-card${n.unschedulable ? " cordoned" : ""}${n.ready ? "" : " notready"}">
        <div class="node-head"><strong>${esc(n.name)}</strong><span class="meta">${esc(n.roles.join(", ") || "worker")}</span>
          ${n.unschedulable ? `<span class="badge warn">SchedulingDisabled</span>` : ""}${n.ready ? "" : `<span class="badge bad">NotReady</span>`}</div>
        ${n.taints.length || n.labels.length ? `<div class="node-tags">${n.taints.map((t) => `<span class="badge taint" title="Taint">${esc(t)}</span>`).join("")}${n.labels.map((l) => `<span class="badge label" title="Label">${esc(l)}</span>`).join("")}</div>` : ""}
        <div class="bars">${bar("CPU requests", n.cpuPercent)}${bar("Memory requests", n.memoryPercent)}</div>
        ${mine.length ? this.groups(mine, showNs) : `<p class="meta empty">No Pods${this.namespace ? ` from ${esc(this.namespace)}` : ""}.</p>`}
        ${done ? `<p class="meta">+ ${done} completed</p>` : ""}
      </div>`;
    });
    const unscheduled = pods.filter((p) => !p.node);
    if (unscheduled.length) {
      cards.push(`<div class="node-card unscheduled"><div class="node-head"><strong>Not scheduled</strong><span class="meta">Pending, no node fits yet</span></div>${this.groups(unscheduled, showNs)}</div>`);
    }
    return `<div class="nodes">${cards.join("")}</div>`;
  }

  private networkHtml(v: ClusterView): string {
    const W = 500;
    const pods = [...v.pods, ...[...this.ghosts.values()].map((g) => g.pod)].filter((p) => p.state !== "done");
    const multiNs = new Set([...pods.map((p) => p.ns), ...v.services.map((s) => s.ns)]).size > 1;
    const label = (ns: string, name: string) => (multiNs ? `${ns}/${name}` : name);
    this.boxes.clear();
    const col = { client: 4, ingress: 84, service: 204, pod: 340 };
    // Pods, grouped by owner.
    let y = 34;
    const byOwner = new Map<string, PodView[]>();
    for (const p of pods) {
      const k = `${p.ns}/${p.owner ? `${p.owner.kind} ${p.owner.name}` : "Pod"}`;
      byOwner.set(k, [...(byOwner.get(k) ?? []), p]);
    }
    const podSvg: string[] = [];
    for (const [k, list] of [...byOwner].sort(([a], [b]) => a.localeCompare(b))) {
      podSvg.push(`<text x="${col.pod}" y="${y + 10}" class="g-title">${esc(multiNs ? k : k.split("/").slice(1).join("/"))}</text>`);
      y += 16;
      for (const p of list) {
        const b = { x: col.pod, y, w: 156, h: 22 };
        this.boxes.set(`pod:${p.ns}/${p.name}`, b);
        const sel = this.selectedPod === p.uid ? " sel" : "";
        const hl = this.selectedPolicy && v.policies.find((x) => x.uid === this.selectedPolicy)?.pods.includes(p.uid) ? " hl" : "";
        const fresh = this.seen.size > 0 && !this.seen.has(p.uid) ? " new" : "";
        const gone = this.ghosts.has(p.uid) ? " gone" : "";
        const short = p.name.replace(/-([a-z0-9]{8,10})-([a-z0-9]{5})$/, "-…-$2");
        podSvg.push(`<g class="n-pod s-${p.state}${sel}${hl}${fresh}${gone}" data-pod="${esc(p.uid)}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5"/><circle cx="${b.x + 10}" cy="${b.y + 11}" r="4" class="dot-svg"/><text x="${b.x + 20}" y="${b.y + 15}">${esc(short)}</text>${p.ingressPolicy || p.egressPolicy ? `<path class="shield" transform="translate(${b.x + b.w - 16},${b.y + 4})" d="M6 0 L12 2.5 V7 C12 10.5 9 13 6 14 C3 13 0 10.5 0 7 V2.5 Z"/>` : ""}<title>${esc(`${p.ns}/${p.name}\n${p.status} · ${p.ready} ready${p.ip ? ` · ${p.ip}` : ""}`)}</title></g>`);
        y += 26;
      }
      y += 6;
    }
    const height = Math.max(y + 10, 200);
    // Services, placed next to their Pods.
    const centerOf = (uids: string[]) => {
      const ys = uids.map((u) => pods.find((p) => p.uid === u)).filter(Boolean).map((p) => this.boxes.get(`pod:${p!.ns}/${p!.name}`)!.y + 11);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : undefined;
    };
    const svcs = v.services.map((s) => ({ s, want: centerOf([...s.ready, ...s.notReady]) ?? 0 })).sort((a, b) => a.want - b.want);
    let next = 34;
    const svcSvg: string[] = [];
    const edges: string[] = [];
    for (const { s, want } of svcs) {
      const h = 34;
      const top = Math.max(next, (want || next + h / 2) - h / 2);
      const b = { x: col.service, y: top, w: 116, h };
      this.boxes.set(`svc:${s.ns}/${s.name}`, b);
      next = top + h + 10;
      svcSvg.push(`<g class="n-svc${s.ready.length ? "" : " empty"}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/><text x="${b.x + 8}" y="${b.y + 14}" class="strong">${esc(label(s.ns, s.name))}</text><text x="${b.x + 8}" y="${b.y + 27}" class="small">${esc(s.type === "ExternalName" ? `→ ${s.externalName}` : `${s.type} ${s.ports.join(", ")}`)}</text><title>${esc(`Service ${s.ns}/${s.name}\nselector: ${Object.entries(s.selector).map(([k, x]) => `${k}=${x}`).join(", ") || "none"}\nendpoints: ${s.ready.length} ready, ${s.notReady.length} not ready`)}</title></g>`);
      for (const [uids, cls] of [[s.ready, "e-ready"], [s.notReady, "e-notready"]] as const) {
        for (const u of uids) {
          const p = pods.find((x) => x.uid === u);
          const pb = p && this.boxes.get(`pod:${p.ns}/${p.name}`);
          if (pb) edges.push(curve(b.x + b.w, b.y + b.h / 2, pb.x, pb.y + 11, cls));
        }
      }
    }
    // Ingresses, next to the Services they route to.
    const ingSvg: string[] = [];
    next = 70;
    for (const ing of v.ingresses) {
      const targets = ing.routes.map((r) => this.boxes.get(`svc:${ing.ns}/${r.service}`)).filter(Boolean) as Box[];
      const want = targets.length ? targets.reduce((a, b) => a + b.y + b.h / 2, 0) / targets.length : next;
      const h = 26 + ing.routes.length * 12;
      const top = Math.max(next, want - h / 2);
      const b = { x: col.ingress, y: top, w: 104, h };
      this.boxes.set(`ing:${ing.ns}/${ing.name}`, b);
      next = top + h + 12;
      ingSvg.push(`<g class="n-ing"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/><text x="${b.x + 8}" y="${b.y + 15}" class="strong">Ingress ${esc(label(ing.ns, ing.name))}</text>${ing.routes.map((r, i) => `<text x="${b.x + 8}" y="${b.y + 28 + i * 12}" class="small">${esc(`${r.host === "*" ? "" : r.host}${r.path} → ${r.service}`.slice(0, 20))}</text>`).join("")}</g>`);
      ing.routes.forEach((r, i) => {
        const sb = this.boxes.get(`svc:${ing.ns}/${r.service}`);
        if (sb) edges.push(curve(b.x + b.w, b.y + 24 + i * 12, sb.x, sb.y + sb.h / 2, "e-route"));
      });
    }
    // Clients: your terminal and anything outside the view.
    const cb = { x: col.client, y: 34, w: 68, h: 40 };
    this.boxes.set("client", cb);
    const clientSvg = `<g class="n-client"><rect x="${cb.x}" y="${cb.y}" width="${cb.w}" height="${cb.h}" rx="6"/><text x="${cb.x + 8}" y="${cb.y + 16}" class="strong">Clients</text><text x="${cb.x + 8}" y="${cb.y + 30}" class="small">terminal</text></g>`;
    for (const ing of v.ingresses) {
      const b = this.boxes.get(`ing:${ing.ns}/${ing.name}`)!;
      edges.push(curve(cb.x + cb.w, cb.y + cb.h / 2, b.x, b.y + 13, "e-client"));
    }
    for (const s of v.services.filter((x) => x.nodePorts.length)) {
      const b = this.boxes.get(`svc:${s.ns}/${s.name}`)!;
      edges.push(curve(cb.x + cb.w, cb.y + cb.h / 2, b.x, b.y + b.h / 2, "e-client"));
    }
    const heads = `<text x="${col.client}" y="18" class="col-head">Clients</text><text x="${col.ingress}" y="18" class="col-head">Ingress</text><text x="${col.service}" y="18" class="col-head">Services</text><text x="${col.pod}" y="18" class="col-head">Pods</text>`;
    const empty = !pods.length && !v.services.length ? `<text x="${W / 2}" y="120" text-anchor="middle" class="small">Nothing here yet. Create a Deployment and a Service and watch them appear.</text>` : "";
    const svg = `<svg class="net" viewBox="0 0 ${W} ${height}" width="100%" role="img" aria-label="Network map"><defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" class="arrow"/></marker></defs>${heads}<g class="edges">${edges.join("")}</g>${clientSvg}${ingSvg.join("")}${svcSvg.join("")}${podSvg.join("")}${empty}<g id="traffic"></g></svg>`;
    const policies = v.policies.length
      ? `<div class="policies"><span class="meta">NetworkPolicies:</span> ${v.policies.map((p) => `<button class="chip${p.uid === this.selectedPolicy ? " active" : ""}" data-policy="${esc(p.uid)}">${esc(label(p.ns, p.name))}</button>`).join(" ")}</div>`
      : `<div class="policies meta">No NetworkPolicies here: every Pod accepts traffic from everywhere.</div>`;
    const sp = v.policies.find((p) => p.uid === this.selectedPolicy);
    const rules = sp ? `<div class="policy-rules"><strong>${esc(sp.name)}</strong> selects ${sp.pods.length} Pod${sp.pods.length === 1 ? "" : "s"} (outlined).<ul>${sp.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : "";
    return `${svg}${policies}${rules}<p class="meta">Requests show up as dots: green when they get through, red where a NetworkPolicy or a missing endpoint stops them. Try <code>kubectl run tmp --rm -i --image=busybox --restart=Never -- wget -qO- http://SERVICE</code>.</p>`;
  }

  private wire(body: HTMLElement): void {
    body.querySelectorAll<Element>("[data-pod]").forEach((el) =>
      el.addEventListener("click", () => {
        const uid = (el as HTMLElement).dataset.pod!;
        this.selectedPod = this.selectedPod === uid ? undefined : uid;
        this.signature = "";
        this.refresh();
      }),
    );
    body.querySelectorAll<HTMLButtonElement>("[data-policy]").forEach((el) =>
      el.addEventListener("click", () => {
        this.selectedPolicy = this.selectedPolicy === el.dataset.policy ? undefined : el.dataset.policy;
        this.signature = "";
        this.refresh();
      }),
    );
  }

  private renderDetail(v: ClusterView): void {
    const box = this.el!.querySelector<HTMLElement>("#viz-detail")!;
    const p = v.pods.find((x) => x.uid === this.selectedPod);
    if (!p) {
      box.innerHTML = `<p class="meta">Click a Pod for details. The view updates by itself as you run commands.</p>`;
      return;
    }
    const svcs = v.services.filter((s) => s.ready.includes(p.uid) || s.notReady.includes(p.uid));
    const pols = v.policies.filter((x) => x.pods.includes(p.uid));
    const nsFlag = p.ns === this.currentNamespace() ? "" : ` -n ${p.ns}`;
    box.innerHTML = `<div class="pod-detail">
      <div><strong>${esc(p.name)}</strong> <span class="badge s-${p.state}">${esc(p.status)}</span></div>
      <table>
        <tr><td>Namespace</td><td>${esc(p.ns)}</td></tr>
        <tr><td>Node</td><td>${esc(p.node ?? "not scheduled")}</td></tr>
        <tr><td>IP</td><td>${esc(p.ip ?? "none yet")}</td></tr>
        <tr><td>Ready</td><td>${esc(p.ready)}${p.restarts ? ` · ${p.restarts} restart${p.restarts === 1 ? "" : "s"}` : ""}</td></tr>
        <tr><td>Owner</td><td>${esc(p.owner ? `${p.owner.kind} ${p.owner.name}` : "none (bare Pod)")}</td></tr>
        <tr><td>Images</td><td>${esc(p.images.join(", "))}</td></tr>
        <tr><td>Labels</td><td>${Object.entries(p.labels).map(([k, x]) => `<code>${esc(`${k}=${x}`)}</code>`).join(" ") || "none"}</td></tr>
        <tr><td>Services</td><td>${svcs.map((s) => esc(s.name)).join(", ") || "none select it"}</td></tr>
        <tr><td>Policies</td><td>${pols.map((x) => esc(x.name)).join(", ") || "none"}</td></tr>
      </table>
      <p class="meta">More: <code>kubectl describe pod ${esc(p.name)}${esc(nsFlag)}</code></p>
    </div>`;
  }

  private flights: { pts: [number, number][]; ok: boolean; label?: string; start: number; dur: number; el?: SVGGElement }[] = [];
  private raf = 0;

  private animate(cluster: Cluster): void {
    const events = trafficEvents(cluster, this.lastSeq);
    if (events.length) {
      this.lastSeq = events.at(-1)!.seq;
      for (const e of events.slice(-8)) this.addFlight(e);
    }
    if (this.flights.length && !this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  private addFlight(e: TrafficEvent): void {
    const client = this.boxes.get("client");
    if (!client) return;
    let src: [number, number];
    if (e.from && this.boxes.has(`pod:${e.from.ns}/${e.from.name}`)) {
      const b = this.boxes.get(`pod:${e.from.ns}/${e.from.name}`)!;
      src = [b.x, b.y + 11];
    } else if (e.from?.ns === "ingress-nginx") {
      const ing = [...this.boxes.entries()].find(([k]) => k.startsWith("ing:"));
      src = ing ? [ing[1].x + ing[1].w, ing[1].y + 13] : [client.x + client.w, client.y + client.h / 2];
    } else src = [client.x + client.w, client.y + client.h / 2];
    const sb = e.service && this.boxes.get(`svc:${e.service.ns}/${e.service.name}`);
    const pb = e.pod && this.boxes.get(`pod:${e.pod.ns}/${e.pod.name}`);
    if (!sb && !pb) return;
    let pts: [number, number][] = [src];
    // Pods sit right of the Services, so requests from a Pod enter the Service from its right side.
    if (sb && src[0] > sb.x + sb.w) pts.push([sb.x + sb.w, sb.y + sb.h / 2]);
    else if (sb) pts.push([sb.x, sb.y + sb.h / 2], [sb.x + sb.w, sb.y + sb.h / 2]);
    if (pb && (e.ok || e.blocked === "ingress-policy")) pts.push([pb.x, pb.y + 11]);
    if (e.blocked === "egress-policy" || e.blocked === "dns") pts = [src, [src[0] + (src[0] > 250 ? -22 : 22), src[1]]];
    const label = e.ok
      ? undefined
      : e.blocked === "ingress-policy"
        ? "✕ blocked by NetworkPolicy"
        : e.blocked === "egress-policy"
          ? "✕ egress denied"
          : e.blocked === "dns"
            ? "✕ DNS blocked"
            : e.error === "refused"
              ? "✕ no ready endpoints"
              : "✕ failed";
    this.flights.push({ pts, ok: e.ok, label, start: performance.now(), dur: 1200 });
  }

  private frame(): void {
    this.raf = 0;
    const layer = this.el?.querySelector<SVGGElement>("#traffic");
    const now = performance.now();
    const ns = "http://www.w3.org/2000/svg";
    this.flights = this.flights.filter((f) => now - f.start < f.dur + (f.ok ? 200 : 1800));
    if (!layer) {
      this.flights = [];
      return;
    }
    for (const f of this.flights) {
      if (!f.el || !f.el.isConnected) {
        f.el = document.createElementNS(ns, "g");
        f.el.setAttribute("class", f.ok ? "flight ok" : "flight blocked");
        const dot = document.createElementNS(ns, "circle");
        dot.setAttribute("r", "5");
        f.el.appendChild(dot);
        layer.appendChild(f.el);
      }
      const k = Math.min(1, (now - f.start) / f.dur);
      const [x, y] = along(f.pts, k);
      const dot = f.el.querySelector("circle")!;
      dot.setAttribute("cx", x.toFixed(1));
      dot.setAttribute("cy", y.toFixed(1));
      if (k === 1 && f.label && !f.el.querySelector("text")) {
        const t = document.createElementNS(ns, "text");
        const end = f.pts.at(-1)!;
        t.setAttribute("x", String(Math.min(end[0], 330)));
        t.setAttribute("y", String(end[1] - 9));
        t.setAttribute("class", "blocked-label");
        t.textContent = f.label;
        f.el.appendChild(t);
      }
    }
    for (const el of [...layer.children]) if (!this.flights.some((f) => f.el === el)) el.remove();
    if (this.flights.length) this.raf = requestAnimationFrame(() => this.frame());
  }
}

/** The point at fraction k (0..1) of the way along a polyline. */
function along(pts: [number, number][], k: number): [number, number] {
  const segs = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  let d = segs.reduce((a, b) => a + b, 0) * k;
  for (let i = 0; i < segs.length; i++) {
    if (d <= segs[i] || i === segs.length - 1) {
      const t = segs[i] ? Math.min(1, d / segs[i]) : 1;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }
    d -= segs[i];
  }
  return pts[0];
}

function curve(x1: number, y1: number, x2: number, y2: number, cls: string): string {
  const mx = (x1 + x2) / 2;
  return `<path class="${cls}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2 - 2} ${y2}" marker-end="url(#arr)"/>`;
}
