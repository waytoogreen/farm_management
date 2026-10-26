/*
 * Farm Dashboard page  (v2 - redesigned)
 * Path: apps/agriculture/agriculture/agriculture/page/farm_dashboard/farm_dashboard.js
 * Uses the same get_dashboard_data API in farm_dashboard.py (no Python change needed).
 */
frappe.pages["farm-dashboard"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: __("Farm Dashboard"), single_column: true });
	new FarmDashboard(page, wrapper);
};

class FarmDashboard {
	constructor(page, wrapper) {
		this.page = page;
		this.method = "agriculture.agriculture.page.farm_dashboard.farm_dashboard.get_dashboard_data";
		this.setup_filters();
		this.inject_style();
		this.body = $(`<div class="fd"></div>`).appendTo(page.main);
		page.set_primary_action(__("Refresh"), () => this.refresh(), "refresh");
		this.refresh();
		$(wrapper).on("show", () => this.refresh());
	}

	// ------------------------------------------------------------ filters / data
	setup_filters() {
		const p = this.page;
		const mk = (fieldname, label, fieldtype, options) =>
			p.add_field({ fieldname, label: __(label), fieldtype, options, change: () => this.refresh() });
		this.f = {
			farmer: mk("farmer", "Farmer", "Link", "Farmer"),
			crop_cycle: mk("crop_cycle", "Crop Cycle", "Link", "Crop Cycle"),
			from_date: mk("from_date", "From", "Date"),
			to_date: mk("to_date", "To", "Date"),
		};
	}

	args() {
		const g = (k) => this.f[k].get_value() || null;
		return { farmer: g("farmer"), crop_cycle: g("crop_cycle"), from_date: g("from_date"), to_date: g("to_date") };
	}

	refresh() {
		this.body.html(`<div class="fd-loading"><div class="fd-spin"></div>${__("Loading your farm data...")}</div>`);
		frappe.call({
			method: this.method,
			args: this.args(),
			callback: (r) => r.message && this.render(r.message),
		});
	}

	// ------------------------------------------------------------ helpers
	money(v) { return format_currency(v || 0); }
	num(v) { return flt(v || 0, 2).toLocaleString(); }
	esc(v) { return frappe.utils.escape_html(v == null ? "" : String(v)); }
	link(dt, name) { return `<a href="/app/${frappe.router.slug(dt)}/${encodeURIComponent(name)}">${this.esc(name)}</a>`; }
	pill(text, kind) { return `<span class="fd-pill fd-pill-${kind}">${this.esc(text)}</span>`; }

	counter(value, kind) {
		return `<span class="fd-count" data-val="${flt(value)}" data-kind="${kind}">${kind === "money" ? this.money(0) : "0"}</span>`;
	}

	animate_counters() {
		const fmt = (v, kind) => (kind === "money" ? this.money(v) : kind === "int" ? Math.round(v).toLocaleString() : this.num(v));
		this.body.find(".fd-count").each((_, el) => {
			const end = flt(el.dataset.val), kind = el.dataset.kind, t0 = performance.now(), dur = 900;
			const step = (t) => {
				const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
				el.textContent = fmt(end * e, kind);
				if (p < 1) requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
		});
	}

	spark(values, color) {
		if (!values || values.length < 2) return `<div class="fd-spark-empty"></div>`;
		const w = 120, h = 34, max = Math.max(...values), min = Math.min(...values), rng = max - min || 1;
		const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 4 - ((v - min) / rng) * (h - 8)]);
		const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
		const area = `${line} L${w},${h} L0,${h} Z`;
		const id = "g" + Math.random().toString(36).slice(2, 7);
		return `<svg class="fd-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
			<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
			<path d="${area}" fill="url(#${id})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	}

	ring(pct, color, size = 150, stroke = 14) {
		const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct));
		return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="fd-ring">
			<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--fd-track)" stroke-width="${stroke}"/>
			<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
				stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c}" transform="rotate(-90 ${size / 2} ${size / 2})"
				style="--target:${c * (1 - p / 100)}" class="fd-ring-arc"/>
			<text x="50%" y="50%" text-anchor="middle" dy=".1em" class="fd-ring-text">${Math.round(p)}%</text>
			<text x="50%" y="50%" text-anchor="middle" dy="1.9em" class="fd-ring-sub">${__("collected")}</text></svg>`;
	}

	bar(label, value, pct, color, right) {
		return `<div class="fd-bar"><div class="fd-bar-top"><span>${label}</span><b>${right || value}</b></div>
			<div class="fd-bar-track"><div class="fd-bar-fill" style="--w:${Math.max(pct, 1.5)}%;background:${color}"></div></div></div>`;
	}

	stack(items) {
		const total = items.reduce((t, i) => t + flt(i.value), 0);
		if (!total) return "";
		const segs = items
			.map((i) => `<div class="fd-seg" style="flex:${i.value};background:${i.color}" title="${this.esc(i.label)}: ${i.value}"></div>`)
			.join("");
		const legend = items
			.map((i) => `<span><i style="background:${i.color}"></i>${this.esc(i.label)} <b>${i.value}</b></span>`)
			.join("");
		return `<div class="fd-stack">${segs}</div><div class="fd-stack-legend">${legend}</div>`;
	}

	section(title, subtitle) {
		return `<div class="fd-section"><h3>${title}</h3>${subtitle ? `<span>${subtitle}</span>` : ""}</div>`;
	}

	table(headers, rows, empty) {
		const body = rows.length
			? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")
			: `<tr><td colspan="${headers.length}" class="fd-empty">${empty}</td></tr>`;
		return `<div class="fd-tablewrap"><table class="fd-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
	}

	chart(sel, hasData, cfg) {
		const el = this.body.find(sel);
		if (!hasData) return el.html(`<div class="fd-empty">${__("No data yet")}</div>`);
		new frappe.Chart(el[0], Object.assign({ height: 240, animate: 1 }, cfg));
	}

	// ------------------------------------------------------------ render
	render(d) {
		const k = d.kpis, m = d.monthly;
		const profit = k.net_profit, positive = profit >= 0;
		const collectedPct = k.sales ? (k.received / k.sales) * 100 : 0;
		const profitSeries = m.labels.map((_, i) => m.sales[i] - m.expense[i]);
		const user = frappe.session.user_fullname || "";
		const hr = new Date().getHours();
		const greet = hr < 12 ? __("Good morning") : hr < 17 ? __("Good afternoon") : __("Good evening");
		const filters = this.args();
		const scope = [filters.farmer, filters.crop_cycle].filter(Boolean).join(" · ") || __("All farms & crop cycles");

		const kpi = (icon, label, valueHtml, sub, color, series) => `
			<div class="fd-kpi" style="--c:${color}">
				<div class="fd-kpi-head"><div class="fd-kpi-icon">${icon}</div><div class="fd-kpi-label">${label}</div></div>
				<div class="fd-kpi-value">${valueHtml}</div>
				<div class="fd-kpi-sub">${sub || "&nbsp;"}</div>
				${series ? this.spark(series, color) : ""}
			</div>`;

		const hero = `
			<div class="fd-hero">
				<svg class="fd-hero-art" viewBox="0 0 400 200" preserveAspectRatio="xMaxYMid slice">
					<circle cx="330" cy="40" r="110" fill="rgba(255,255,255,.08)"/><circle cx="380" cy="170" r="80" fill="rgba(255,255,255,.07)"/>
					<circle cx="250" cy="150" r="40" fill="rgba(255,255,255,.06)"/></svg>
				<div class="fd-hero-left">
					<div class="fd-hero-hi">${greet}${user ? ", " + this.esc(user.split(" ")[0]) : ""} 👋</div>
					<div class="fd-hero-title">🌾 ${__("Farm Overview")}</div>
					<div class="fd-hero-scope">${this.esc(scope)}</div>
					<div class="fd-chips">
						<span>🧑‍🌾 ${k.farmers} ${__("farmers")}</span><span>🏡 ${k.farms} ${__("farms")}</span>
						<span>🗺️ ${k.plots} ${__("plots")}</span><span>🌱 ${k.cycles} ${__("crop cycles")}</span>
						<span>📐 ${flt(k.area, 2)} ${__("area")}</span>
					</div>
				</div>
				<div class="fd-hero-right">
					<div class="fd-hero-label">${__("Net Profit")}</div>
					<div class="fd-hero-profit ${positive ? "" : "neg"}">${this.counter(profit, "money")}</div>
					<div class="fd-hero-margin">${positive ? "▲" : "▼"} ${flt(Math.abs(k.margin), 1)}% ${__("margin")}</div>
				</div>
			</div>`;

		const kpis = `<div class="fd-kpis">
			${kpi("💸", __("Total Expense"), this.counter(k.expense, "money"), `${__("Labour")}: ${this.money(k.labour)}`, "#ef4444", m.expense)}
			${kpi("🛒", __("Total Sales"), this.counter(k.sales, "money"), `${__("Qty sold")}: ${this.num(k.sold_qty)}`, "#3b82f6", m.sales)}
			${kpi("💰", __("Received"), this.counter(k.received, "money"), `${__("Transport")}: ${this.money(k.transport)}`, "#10b981")}
			${kpi("⏳", __("Pending Payment"), this.counter(k.pending, "money"), `${flt(100 - collectedPct, 0)}% ${__("yet to collect")}`, "#f59e0b")}
			${kpi("🧺", __("Usable Harvest"), this.counter(k.usable, "num"), `${this.num(k.damaged)} ${__("damaged")}`, "#8b5cf6")}
			${kpi("📦", __("Stock Balance"), this.counter(k.balance, "num"), `${__("Ready to sell")}`, "#6366f1")}
			${kpi("🩺", __("Open Health Issues"), this.counter(k.open_issues, "int"), k.open_issues ? __("Needs attention") : __("All healthy"), k.open_issues ? "#ef4444" : "#22c55e")}
			${kpi("🌧️", __("Rainfall"), `${this.counter(k.rain, "num")} mm`, `${d.field.obs} ${__("observations")}`, "#06b6d4")}
		</div>`;

		const fieldStrip = `<div class="fd-strip">
			<span class="${d.field.waterlogging ? "warn" : ""}">💧 ${d.field.waterlogging} ${__("waterlogging")}</span>
			<span class="${d.field.drought ? "warn" : ""}">☀️ ${d.field.drought} ${__("drought stress")}</span>
			<span class="${d.field.pest ? "warn" : ""}">🐛 ${d.field.pest} ${__("pest reports")}</span></div>`;

		// money flow
		const totalExp = d.expense_by_category.reduce((t, r) => t + flt(r.amount), 0) || 1;
		const catColors = ["#f97316", "#3b82f6", "#10b981", "#a855f7", "#eab308", "#ef4444", "#14b8a6", "#6366f1", "#84cc16", "#ec4899"];
		const spendBars = d.expense_by_category.length
			? d.expense_by_category
					.map((r, i) => this.bar(this.esc(r.category), "", (flt(r.amount) / totalExp) * 100, catColors[i % catColors.length], `${this.money(r.amount)} · ${flt((flt(r.amount) / totalExp) * 100, 0)}%`))
					.join("")
			: `<div class="fd-empty">${__("No expenses yet")}</div>`;

		const collect = `
			<div class="fd-collect">
				${this.ring(collectedPct, "#10b981")}
				<div class="fd-collect-legend">
					<div><i style="background:#10b981"></i>${__("Received")}<b>${this.money(k.received)}</b></div>
					<div><i style="background:#f59e0b"></i>${__("Pending")}<b>${this.money(k.pending)}</b></div>
					<div><i style="background:#3b82f6"></i>${__("Total sales")}<b>${this.money(k.sales)}</b></div>
				</div>
			</div>`;

		// harvest funnel
		const hv = k.harvest || 0;
		const pct = (x) => (hv ? (x / hv) * 100 : 0);
		const funnel = [
			this.bar(__("Harvested"), "", 100, "#8b5cf6", this.num(k.harvest)),
			this.bar(__("Damaged"), "", pct(k.damaged), "#ef4444", `${this.num(k.damaged)} · ${flt(pct(k.damaged), 0)}%`),
			this.bar(__("Usable"), "", pct(k.usable), "#22c55e", `${this.num(k.usable)} · ${flt(pct(k.usable), 0)}%`),
			this.bar(__("Sold"), "", pct(k.sold_qty), "#3b82f6", `${this.num(k.sold_qty)} · ${flt(pct(k.sold_qty), 0)}%`),
			this.bar(__("In stock"), "", pct(k.balance), "#f59e0b", `${this.num(k.balance)} · ${flt(pct(k.balance), 0)}%`),
		].join("");

		// tables
		const cycleRows = d.cycles.map((c, i) => [
			`${i === 0 && c.profit > 0 ? "🏆 " : ""}${this.link("Crop Cycle", c.name)}`,
			this.esc(c.crop),
			this.money(c.expense),
			this.money(c.sales),
			`<b class="${c.profit >= 0 ? "pos" : "neg"}">${this.money(c.profit)}</b>`,
			`<div class="fd-mini"><div style="width:${Math.min(Math.abs(c.margin), 100)}%;background:${c.margin >= 0 ? "#22c55e" : "#ef4444"}"></div></div><small>${flt(c.margin, 1)}%</small>`,
			c.usable ? this.money(c.cost_per_unit) : "-",
		]);

		const healthCards = d.health_open.length
			? d.health_open
					.map(
						(h) => `<div class="fd-issue sev-${(h.severity || "low").toLowerCase()}">
					<div class="fd-issue-top">${this.link("Crop Health Report", h.name)}${this.pill(h.status, h.status === "Escalated" ? "high" : "medium")}</div>
					<div class="fd-issue-title">${this.esc(h.pest__disease || h.issue_type || __("Issue"))}</div>
					<div class="fd-issue-meta">${this.pill(h.severity || "-", (h.severity || "low").toLowerCase())}
						<span>${h.follow_up_date ? "📅 " + frappe.datetime.str_to_user(h.follow_up_date) : ""}</span>
						${h.overdue ? this.pill(__("Overdue"), "high") : ""}</div></div>`
					)
					.join("")
			: `<div class="fd-empty">${__("No open issues 🎉")}</div>`;

		const payRows = d.pending_sales.map((s) => [
			this.link("Farm Sale", s.name),
			this.esc(s.farmer || ""),
			`<b>${this.money(s.pending)}</b>`,
			this.pill(s.payment_status, s.payment_status === "Partial" ? "medium" : "high"),
			`${s.days} ${__("days")}`,
		]);

		const timeline = d.activities.length
			? d.activities
					.map(
						(a) => `<div class="fd-tl"><div class="fd-tl-dot"></div><div class="fd-tl-body">
					<div class="fd-tl-top"><b>${this.pill(a.activity_type || "-", "info")}</b>
					<span>${frappe.datetime.str_to_user(a.activity_date)}</span></div>
					<div>${this.link("Farm Activity", a.name)} · ${this.esc(a.crop || "")}</div>
					<div class="fd-tl-cost">${this.money(a.total_cost)}</div></div></div>`
					)
					.join("")
			: `<div class="fd-empty">${__("No activities")}</div>`;

		this.body.html(`
			${hero}
			${kpis}
			${fieldStrip}

			${this.section(__("💹 Money Flow"), __("Monthly expense vs sales, and how much you have collected"))}
			<div class="fd-grid g-21">
				<div class="fd-card"><div class="fd-card-title">${__("Monthly Expense vs Sales")}</div><div id="fd-monthly"></div></div>
				<div class="fd-card"><div class="fd-card-title">${__("Payment Collection")}</div>${collect}<div class="fd-stackwrap">${this.stack(d.payment_status.map((r) => ({ label: r.status, value: r.cnt, color: { Paid: "#22c55e", Partial: "#f59e0b", Pending: "#ef4444" }[r.status] || "#94a3b8" })))}</div></div>
			</div>

			${this.section(__("🧾 Spending & Harvest"), __("Where the money goes and what the land gave back"))}
			<div class="fd-grid g-3">
				<div class="fd-card"><div class="fd-card-title">${__("Expense by Category")}</div>${spendBars}</div>
				<div class="fd-card"><div class="fd-card-title">${__("Harvest Funnel")}</div>${funnel}</div>
				<div class="fd-card"><div class="fd-card-title">${__("Harvest by Crop")}</div><div id="fd-harvest"></div></div>
			</div>

			${this.section(__("🏆 Crop Cycle Profitability"), __("Ranked by profit"))}
			<div class="fd-card">${this.table([__("Cycle"), __("Crop"), __("Expense"), __("Sales"), __("Profit"), __("Margin"), __("Cost / Unit")], cycleRows, __("No crop cycles"))}</div>

			${this.section(__("🩺 Crop Health & Collections"), __("What needs attention now"))}
			<div class="fd-grid g-2">
				<div class="fd-card"><div class="fd-card-title">${__("Open Health Issues")} <small>(${k.open_issues})</small></div>
					<div class="fd-issues">${healthCards}</div>
					<div class="fd-stackwrap">${this.stack(d.health_by_severity.map((r) => ({ label: r.severity, value: r.cnt, color: { High: "#ef4444", Medium: "#f59e0b", Low: "#22c55e" }[r.severity] || "#94a3b8" })))}</div></div>
				<div class="fd-card"><div class="fd-card-title">${__("Payments to Collect")}</div>
					${this.table([__("Sale"), __("Farmer"), __("Pending"), __("Status"), __("Age")], payRows, __("Nothing pending 🎉"))}</div>
			</div>

			${this.section(__("🕒 Recent Farm Activities"), __("Latest work on the field"))}
			<div class="fd-card"><div class="fd-timeline">${timeline}</div></div>
		`);

		this.animate_counters();

		// ---- frappe charts
		this.chart("#fd-monthly", m.labels.length, {
			type: "axis-mixed",
			colors: ["#ef4444", "#22c55e"],
			axisOptions: { xIsSeries: 1 },
			data: {
				labels: m.labels,
				datasets: [
					{ name: __("Expense"), values: m.expense, chartType: "bar" },
					{ name: __("Sales"), values: m.sales, chartType: "line" },
				],
			},
			lineOptions: { regionFill: 1 },
			barOptions: { spaceRatio: 0.45 },
		});

		this.chart("#fd-harvest", d.harvest_by_crop.length, {
			type: "bar",
			colors: ["#8b5cf6", "#3b82f6", "#f59e0b"],
			barOptions: { spaceRatio: 0.4 },
			data: {
				labels: d.harvest_by_crop.map((r) => r.crop),
				datasets: [
					{ name: __("Usable"), values: d.harvest_by_crop.map((r) => flt(r.usable)) },
					{ name: __("Sold"), values: d.harvest_by_crop.map((r) => flt(r.sold)) },
					{ name: __("Balance"), values: d.harvest_by_crop.map((r) => flt(r.balance)) },
				],
			},
		});

	}

	// ------------------------------------------------------------ style
	inject_style() {
		if (document.getElementById("fd-style")) return;
		$(`<style id="fd-style">
		.fd{--fd-card:var(--card-bg,#fff);--fd-bd:var(--border-color,#e5e7eb);--fd-muted:var(--text-muted,#6b7280);--fd-track:rgba(148,163,184,.25);
			padding:4px 2px 40px;animation:fdIn .5s ease}
		@keyframes fdIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
		.fd-loading{display:flex;flex-direction:column;align-items:center;gap:14px;padding:80px;color:var(--fd-muted)}
		.fd-spin{width:38px;height:38px;border:4px solid var(--fd-track);border-top-color:#10b981;border-radius:50%;animation:fdSpin 1s linear infinite}
		@keyframes fdSpin{to{transform:rotate(360deg)}}
		.fd-empty{padding:26px;text-align:center;color:var(--fd-muted)}

		/* hero */
		.fd-hero{position:relative;overflow:hidden;display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap;
			padding:28px 32px;border-radius:22px;color:#fff;margin-bottom:18px;
			background:linear-gradient(120deg,#064e3b 0%,#047857 45%,#10b981 100%);box-shadow:0 14px 34px rgba(5,150,105,.35)}
		.fd-hero-art{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
		.fd-hero-left,.fd-hero-right{position:relative;z-index:1}
		.fd-hero-hi{opacity:.9;font-size:14px}
		.fd-hero-title{font-size:30px;font-weight:800;letter-spacing:.3px;margin:2px 0}
		.fd-hero-scope{opacity:.85;font-size:13px;margin-bottom:12px}
		.fd-chips{display:flex;flex-wrap:wrap;gap:8px}
		.fd-chips span{background:rgba(255,255,255,.18);backdrop-filter:blur(6px);padding:5px 12px;border-radius:999px;font-size:12.5px}
		.fd-hero-right{text-align:right;background:rgba(255,255,255,.14);backdrop-filter:blur(8px);padding:16px 26px;border-radius:18px}
		.fd-hero-label{font-size:12px;text-transform:uppercase;letter-spacing:1px;opacity:.9}
		.fd-hero-profit{font-size:36px;font-weight:800;line-height:1.2}
		.fd-hero-profit.neg{color:#fecaca}
		.fd-hero-margin{font-size:13px;opacity:.95}

		/* kpis */
		.fd-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin-bottom:14px}
		.fd-kpi{position:relative;overflow:hidden;background:var(--fd-card);border:1px solid var(--fd-bd);border-radius:18px;padding:16px 18px 10px;
			box-shadow:0 2px 10px rgba(0,0,0,.05);transition:transform .2s,box-shadow .2s}
		.fd-kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--c)}
		.fd-kpi:hover{transform:translateY(-4px);box-shadow:0 12px 26px rgba(0,0,0,.12)}
		.fd-kpi-head{display:flex;align-items:center;gap:10px}
		.fd-kpi-icon{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:19px;
			background:color-mix(in srgb,var(--c) 15%,transparent)}
		.fd-kpi-label{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--fd-muted);font-weight:600}
		.fd-kpi-value{font-size:25px;font-weight:800;margin:8px 0 0;color:var(--text-color)}
		.fd-kpi-sub{font-size:12px;color:var(--fd-muted);min-height:18px}
		.fd-spark{display:block;width:100%;height:34px;margin-top:4px}
		.fd-spark-empty{height:38px}

		.fd-strip{display:flex;flex-wrap:wrap;gap:10px;margin:2px 0 6px}
		.fd-strip span{background:var(--fd-card);border:1px solid var(--fd-bd);border-radius:999px;padding:6px 14px;font-size:13px}
		.fd-strip span.warn{background:#fef3c7;border-color:#fcd34d;color:#92400e}

		/* sections / cards */
		.fd-section{display:flex;align-items:baseline;gap:12px;margin:26px 0 12px;flex-wrap:wrap}
		.fd-section h3{margin:0;font-size:18px;font-weight:700}
		.fd-section span{color:var(--fd-muted);font-size:13px}
		.fd-grid{display:grid;gap:14px}
		.g-21{grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
		.g-2{grid-template-columns:repeat(2,minmax(0,1fr))}
		.g-3{grid-template-columns:repeat(3,minmax(0,1fr))}
		@media(max-width:1100px){.g-3{grid-template-columns:repeat(2,minmax(0,1fr))}}
		@media(max-width:800px){.g-21,.g-2,.g-3{grid-template-columns:1fr}}
		.fd-card{background:var(--fd-card);border:1px solid var(--fd-bd);border-radius:18px;padding:18px;box-shadow:0 2px 10px rgba(0,0,0,.05);min-width:0}
		.fd-card-title{font-weight:700;font-size:14px;margin-bottom:12px}
		.fd-card-title small{color:var(--fd-muted);font-weight:500}

		/* collection ring */
		.fd-collect{display:flex;align-items:center;gap:18px;flex-wrap:wrap;justify-content:center}
		.fd-ring-arc{animation:fdRing 1.2s ease forwards}
		@keyframes fdRing{to{stroke-dashoffset:var(--target)}}
		.fd-ring-text{font-size:28px;font-weight:800;fill:var(--text-color)}
		.fd-ring-sub{font-size:11px;fill:var(--text-muted)}
		.fd-collect-legend{display:flex;flex-direction:column;gap:10px;font-size:13px}
		.fd-collect-legend div{display:flex;align-items:center;gap:8px}
		.fd-collect-legend i{width:10px;height:10px;border-radius:50%;display:inline-block}
		.fd-collect-legend b{margin-left:auto;padding-left:14px}

		/* bars */
		.fd-bar{margin-bottom:12px}
		.fd-bar-top{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px}
		.fd-bar-track{height:9px;background:var(--fd-track);border-radius:99px;overflow:hidden}
		.fd-bar-fill{height:100%;width:0;border-radius:99px;animation:fdBar 1s ease forwards}
		@keyframes fdBar{to{width:var(--w)}}

		/* tables */
		.fd-tablewrap{overflow-x:auto}
		.fd-table{width:100%;border-collapse:collapse;font-size:13px}
		.fd-table th{text-align:left;color:var(--fd-muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;
			padding:10px 8px;border-bottom:2px solid var(--fd-bd);white-space:nowrap}
		.fd-table td{padding:11px 8px;border-bottom:1px solid var(--fd-bd);vertical-align:middle}
		.fd-table tbody tr:hover{background:rgba(16,185,129,.06)}
		.fd-table tr:last-child td{border-bottom:0}
		.pos{color:#16a34a}.neg{color:#dc2626}
		.fd-mini{display:inline-block;width:60px;height:7px;background:var(--fd-track);border-radius:9px;overflow:hidden;vertical-align:middle;margin-right:6px}
		.fd-mini div{height:100%;border-radius:9px}

		/* pills */
		.fd-pill{padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap}
		.fd-pill-high{background:#fee2e2;color:#b91c1c}
		.fd-pill-medium{background:#fef3c7;color:#b45309}
		.fd-pill-low{background:#dcfce7;color:#15803d}
		.fd-pill-info{background:#dbeafe;color:#1d4ed8}

		/* health */
		.fd-issues{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
		.fd-issue{border:1px solid var(--fd-bd);border-left:5px solid #22c55e;border-radius:12px;padding:10px 12px}
		.fd-issue.sev-high{border-left-color:#ef4444;background:rgba(239,68,68,.05)}
		.fd-issue.sev-medium{border-left-color:#f59e0b;background:rgba(245,158,11,.05)}
		.fd-issue-top{display:flex;justify-content:space-between;align-items:center;font-size:12px;gap:6px}
		.fd-issue-title{font-weight:700;margin:6px 0}
		.fd-issue-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--fd-muted)}

		/* stacked status bar */
		.fd-stackwrap{margin-top:14px}
		.fd-stack{display:flex;height:12px;border-radius:99px;overflow:hidden;background:var(--fd-track);gap:2px}
		.fd-seg{min-width:6px;height:100%}
		.fd-stack-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;font-size:12.5px;color:var(--fd-muted)}
		.fd-stack-legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}
		.fd-stack-legend b{color:var(--text-color);margin-left:2px}

		/* timeline */
		.fd-timeline{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
		.fd-tl{display:flex;gap:12px;position:relative}
		.fd-tl-dot{width:12px;height:12px;border-radius:50%;background:#10b981;margin-top:6px;flex:none;box-shadow:0 0 0 4px rgba(16,185,129,.2)}
		.fd-tl-body{flex:1;border:1px solid var(--fd-bd);border-radius:12px;padding:10px 12px;font-size:13px}
		.fd-tl-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;color:var(--fd-muted);font-size:12px}
		.fd-tl-cost{font-weight:800;margin-top:4px}
		</style>`).appendTo("head");
	}
}