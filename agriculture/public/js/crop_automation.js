/*
 * Crop Management System - client-side automation (Frappe)
 * Include globally via hooks.py -> app_include_js, or split per doctype with doctype_js.
 */
const CMS = "agriculture.farm_automation"; // <-- change to your dotted module path

const f = (v) => flt(v || 0);

// ---------------------------------------------------------------- Farmer
frappe.ui.form.on("Farmer", {
	refresh(frm) {
		if (frm.is_new()) return;
		frm.add_custom_button(__("Farm"), () => frappe.new_doc("Farm", { farmer: frm.doc.name }), __("Create"));
	},
});

// ---------------------------------------------------------------- Farm
frappe.ui.form.on("Farm", {
	refresh(frm) {
		if (frm.is_new()) return;
		frm.add_custom_button(__("Plot"), () => frappe.new_doc("Plot", { farm: frm.doc.name }), __("Create"));
	},
});

// ---------------------------------------------------------------- Plot
frappe.ui.form.on("Plot", {
	refresh(frm) {
		if (frm.is_new()) return;
		frm.add_custom_button(
			__("Start Crop Cycle"),
			() =>
				frappe.new_doc("Crop Cycle", {
					crop: frm.doc.current_crop,
					start_date: frm.doc.sowing_date || frappe.datetime.get_today(),
					title: `${frm.doc.name}-${frm.doc.current_crop || "cycle"}-${frappe.datetime.get_today()}`,
				}),
			__("Create")
		);
	},
});

// ---------------------------------------------------------------- Crop Cycle (dashboard)
frappe.ui.form.on("Crop Cycle", {
	refresh(frm) {
		if (frm.is_new()) return;
		const mk = (dt, label) =>
			frm.add_custom_button(__(label), () => frappe.new_doc(dt, { crop_cycle: frm.doc.name }), __("Create"));
		mk("Farm Activity", "Farm Activity");
		mk("Farm Expense", "Farm Expense");
		mk("Field Observation", "Field Observation");
		mk("Crop Health Report", "Crop Health Report");
		mk("Harvest Entry", "Harvest Entry");

		frappe.call({
			method: `${CMS}.get_crop_cycle_summary`,
			args: { crop_cycle: frm.doc.name },
			callback(r) {
				const s = r.message;
				if (!s) return;
				const fmt = (v) => format_currency(v);
				const profitColor = s.net_profit >= 0 ? "green" : "red";
				const cats = (s.expense_by_category || [])
					.map((c) => `${__(c.category || "Uncategorised")}: ${fmt(c.amount)}`)
					.join(" &nbsp;|&nbsp; ");
				frm.dashboard.add_section(
					`<div class="row">
						<div class="col-sm-3"><b>${__("Total Expense")}</b><br>${fmt(s.total_expense)}</div>
						<div class="col-sm-3"><b>${__("Total Sales")}</b><br>${fmt(s.total_sales)}</div>
						<div class="col-sm-3"><b>${__("Net Profit")}</b><br><span style="color:${profitColor}">${fmt(s.net_profit)}</span></div>
						<div class="col-sm-3"><b>${__("Pending Payment")}</b><br>${fmt(s.pending_amount)}</div>
					</div><br>
					<div class="row">
						<div class="col-sm-3"><b>${__("Usable Harvest")}</b><br>${s.usable_harvest}</div>
						<div class="col-sm-3"><b>${__("Stock Balance")}</b><br>${s.balance_stock}</div>
						<div class="col-sm-3"><b>${__("Cost / Unit")}</b><br>${fmt(s.cost_per_unit)}</div>
						<div class="col-sm-3"><b>${__("Open Health Issues")}</b><br>${s.open_health_issues}</div>
					</div>
					<div class="text-muted small" style="margin-top:8px">${cats}</div>`,
					__("Cycle Summary")
				);
			},
		});
	},
});

// ---------------------------------------------------------------- Farm Activity
frappe.ui.form.on("Farm Activity", {
	setup(frm) {
		frm.set_query("plot", () => (frm.doc.farmer ? { filters: { farmer: frm.doc.farmer } } : {}));
	},
	refresh(frm) {
		if (frm.is_new()) return;
		frm.add_custom_button(
			__("Crop Health Report"),
			() =>
				frappe.new_doc("Crop Health Report", {
					crop_cycle: frm.doc.crop_cycle,
					plot: frm.doc.plot,
					farmer: frm.doc.farmer,
					crop: frm.doc.crop,
				}),
			__("Create")
		);
		if (frm.doc.activity_type === "Harvesting") {
			frm.add_custom_button(
				__("Harvest Entry"),
				() =>
					frappe.new_doc("Harvest Entry", {
						crop_cycle: frm.doc.crop_cycle,
						plot: frm.doc.plot,
						harvest_date: frm.doc.activity_date,
						harvest_quantity: frm.doc.quantity,
					}),
				__("Create")
			);
		}
	},
	crop_cycle(frm) {
		if (!frm.doc.crop_cycle) return;
		frappe.db.get_value("Crop Cycle", frm.doc.crop_cycle, "crop").then((r) => {
			if (r.message) frm.set_value("crop", r.message.crop);
		});
	},
	plot(frm) {
		if (!frm.doc.plot) return;
		frappe.db.get_value("Plot", frm.doc.plot, "farmer").then((r) => {
			if (r.message && r.message.farmer) frm.set_value("farmer", r.message.farmer);
		});
	},
	male_workers: calc_workers,
	female_workers: calc_workers,
	other_workers: calc_workers,
	no_of_labourers: calc_activity_costs,
	labour_duration: calc_activity_costs,
	wage_per_person: calc_activity_costs,
	product_cost: calc_activity_costs,
	other_cost: calc_activity_costs,
	inputs_used_remove: calc_input_total,
});

function calc_workers(frm) {
	const n = (frm.doc.male_workers || 0) + (frm.doc.female_workers || 0) + (frm.doc.other_workers || 0);
	if (n) frm.set_value("no_of_labourers", n);
	calc_activity_costs(frm);
}

function calc_activity_costs(frm) {
	frm.doc.total_labour_cost = f(frm.doc.no_of_labourers) * f(frm.doc.labour_duration) * f(frm.doc.wage_per_person);
	frm.doc.total_cost = f(frm.doc.total_labour_cost) + f(frm.doc.product_cost) + f(frm.doc.other_cost);
	frm.refresh_fields(["total_labour_cost", "total_cost"]);
}

function calc_input_total(frm) {
	if (!(frm.doc.inputs_used || []).length) return;
	frm.doc.product_cost = (frm.doc.inputs_used || []).reduce((t, r) => t + f(r.amount), 0);
	frm.refresh_field("product_cost");
	calc_activity_costs(frm);
}

// Child table: Farm Activity Input (fieldnames assumed: input_item, quantity, rate, amount)
frappe.ui.form.on("Farm Activity Input", {
	input_item(frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		if (!row.input_item) return;
		frappe.db.get_value("Farm Input Item", row.input_item, ["default_rate", "uom"]).then((r) => {
			if (!r.message) return;
			frappe.model.set_value(cdt, cdn, "rate", r.message.default_rate);
			if (r.message.uom) frappe.model.set_value(cdt, cdn, "uom", r.message.uom);
		});
	},
	quantity: calc_input_row,
	rate: calc_input_row,
});

function calc_input_row(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	frappe.model.set_value(cdt, cdn, "amount", f(row.quantity) * f(row.rate));
	calc_input_total(frm);
}

// ---------------------------------------------------------------- Farm Expense
frappe.ui.form.on("Farm Expense", {
	plot(frm) {
		if (!frm.doc.plot) return;
		frappe.db.get_value("Plot", frm.doc.plot, ["farm", "farmer"]).then((r) => {
			if (!r.message) return;
			frm.set_value("farm", r.message.farm);
			frm.set_value("farmer", r.message.farmer);
		});
	},
});

// ---------------------------------------------------------------- Field Observation
frappe.ui.form.on("Field Observation", {
	field_condition(frm) {
		if (frm.doc.field_condition === "Waterlogged") frm.set_value("waterlogging", 1);
		if (["Dry", "Cracked"].includes(frm.doc.field_condition)) frm.set_value("drought_stress", 1);
	},
});

// ---------------------------------------------------------------- Crop Health Report
frappe.ui.form.on("Crop Health Report", {
	crop_cycle(frm) {
		if (!frm.doc.crop_cycle) return;
		frappe.db.get_value("Crop Cycle", frm.doc.crop_cycle, "crop").then((r) => {
			if (r.message) frm.set_value("crop", r.message.crop);
		});
	},
	plot(frm) {
		if (!frm.doc.plot) return;
		frappe.db.get_value("Plot", frm.doc.plot, "farmer").then((r) => {
			if (r.message) frm.set_value("farmer", r.message.farmer);
		});
	},
	severity(frm) {
		const days = { High: 2, Medium: 5, Low: 7 }[frm.doc.severity];
		if (days) frm.set_value("follow_up_date", frappe.datetime.add_days(frm.doc.report_date || frappe.datetime.get_today(), days));
	},
	refresh(frm) {
		if (frm.is_new() || frm.doc.status === "Resolved") return;
		frm.add_custom_button(__("Mark Resolved"), () => {
			frm.set_value("status", "Resolved");
			frm.save();
		});
	},
});

// ---------------------------------------------------------------- Harvest Entry
frappe.ui.form.on("Harvest Entry", {
	refresh(frm) {
		if (frm.doc.docstatus === 1 && f(frm.doc.balance_quantity) > 0) {
			frm.add_custom_button(__("Farm Sale"), () =>
				frappe.new_doc("Farm Sale", {
					harvest_entry: frm.doc.name,
					crop_cycle: frm.doc.crop_cycle,
					quantity_sold: frm.doc.balance_quantity,
					sale_date: frappe.datetime.get_today(),
				}), __("Create"));
		}
	},
	harvest_quantity: calc_harvest,
	damaged_quantity: calc_harvest,
});

function calc_harvest(frm) {
	if (f(frm.doc.damaged_quantity) > f(frm.doc.harvest_quantity)) {
		frappe.msgprint(__("Damaged quantity cannot exceed harvest quantity"));
		return;
	}
	frm.doc.usable_quantity = f(frm.doc.harvest_quantity) - f(frm.doc.damaged_quantity);
	frm.doc.balance_quantity = f(frm.doc.usable_quantity) - f(frm.doc.quantity_sold);
	frm.refresh_fields(["usable_quantity", "balance_quantity"]);
}

// ---------------------------------------------------------------- Farm Sale
frappe.ui.form.on("Farm Sale", {
	setup(frm) {
		frm.set_query("harvest_entry", () => ({
			filters: Object.assign(
				{ docstatus: 1, balance_quantity: [">", 0] },
				frm.doc.crop_cycle ? { crop_cycle: frm.doc.crop_cycle } : {}
			),
		}));
	},
	harvest_entry(frm) {
		if (!frm.doc.harvest_entry) return;
		frappe.call({
			method: `${CMS}.get_harvest_balance`,
			args: { harvest_entry: frm.doc.harvest_entry },
			callback(r) {
				const he = r.message;
				if (!he) return;
				frm.set_value("crop_cycle", he.crop_cycle);
				if (!frm.doc.quantity_sold) frm.set_value("quantity_sold", he.balance_quantity);
				frm.dashboard.set_headline(__("Available balance: {0} {1}", [he.balance_quantity, he.uom || ""]));
				if (he.plot) {
					frappe.db.get_value("Plot", he.plot, "farmer").then((p) => {
						if (p.message && !frm.doc.farmer) frm.set_value("farmer", p.message.farmer);
					});
				}
			},
		});
	},
	quantity_sold: calc_sale,
	rate_per_unit: calc_sale,
	amount_received: calc_sale,
});

function calc_sale(frm) {
	frm.doc.total_value = f(frm.doc.quantity_sold) * f(frm.doc.rate_per_unit);
	let status = "Pending";
	if (f(frm.doc.amount_received) >= f(frm.doc.total_value) && f(frm.doc.total_value) > 0) status = "Paid";
	else if (f(frm.doc.amount_received) > 0) status = "Partial";
	frm.doc.payment_status = status;
	frm.refresh_fields(["total_value", "payment_status"]);
}