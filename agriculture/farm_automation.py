"""
Crop Management System - server-side automation (Frappe / ERPNext)

Flow automated:
  Farmer -> Farm -> Plot -> Crop Cycle
     -> Farm Activity  (auto labour/input/total cost, auto Farm Expense, updates Plot)
     -> Field Observation (auto flags, auto Crop Health Report on pest)
     -> Crop Health Report (auto follow-up date, ToDo, escalation)
     -> Harvest Entry  (usable / balance qty, auto harvest number)
     -> Farm Sale      (total value, payment status, stock check, updates Harvest Entry)
     -> Crop Cycle profitability summary (whitelisted API used by the JS dashboard)

Put this file in your app, e.g. your_app/crop_management/farm_automation.py
and wire it with the hooks.py snippet.
"""

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, getdate, today

# Farm Activity type -> Farm Expense category for the "inputs" cost
ACTIVITY_EXPENSE_CATEGORY = {
    "Sowing": "Seeds",
    "Transplanting": "Seeds",
    "Fertilizer Application": "Fertilizer-Manure",
    "Organic Input Application": "Fertilizer-Manure",
    "Pest Management": "Plant Protection",
    "Disease Management Spraying": "Plant Protection",
    "Irrigation": "Irrigation",
}

FOLLOW_UP_DAYS = {"High": 2, "Medium": 5, "Low": 7}


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------
def _fill_from_crop_cycle(doc):
    if doc.get("crop_cycle") and doc.meta.has_field("crop") and not doc.get("crop"):
        doc.crop = frappe.db.get_value("Crop Cycle", doc.crop_cycle, "crop")


def _fill_from_plot(doc, fill_farm=False):
    if not doc.get("plot"):
        return
    plot = frappe.db.get_value("Plot", doc.plot, ["farmer", "farm"], as_dict=True)
    if not plot:
        return
    if doc.meta.has_field("farmer"):
        if doc.get("farmer") and plot.farmer and doc.farmer != plot.farmer:
            frappe.throw(
                _("Plot {0} belongs to farmer {1}, not {2}").format(doc.plot, plot.farmer, doc.farmer)
            )
        if not doc.get("farmer"):
            doc.farmer = plot.farmer
    if fill_farm and doc.meta.has_field("farm") and not doc.get("farm"):
        doc.farm = plot.farm


def _create_todo(doc, description, date, priority="Medium"):
    existing = frappe.db.get_value(
        "ToDo",
        {"reference_type": doc.doctype, "reference_name": doc.name, "status": "Open"},
        "name",
    )
    if existing:
        frappe.db.set_value("ToDo", existing, {"date": date, "priority": priority, "description": description})
        return
    frappe.get_doc(
        {
            "doctype": "ToDo",
            "allocated_to": doc.owner,
            "reference_type": doc.doctype,
            "reference_name": doc.name,
            "description": description,
            "date": date,
            "priority": priority,
        }
    ).insert(ignore_permissions=True)


def _close_todos(doc):
    for name in frappe.get_all(
        "ToDo",
        filters={"reference_type": doc.doctype, "reference_name": doc.name, "status": "Open"},
        pluck="name",
    ):
        frappe.db.set_value("ToDo", name, "status", "Closed")


# --------------------------------------------------------------------------
# Farm Activity
# --------------------------------------------------------------------------
def farm_activity_validate(doc, method=None):
    _fill_from_crop_cycle(doc)
    _fill_from_plot(doc)

    # workers
    split = cint(doc.male_workers) + cint(doc.female_workers) + cint(doc.other_workers)
    if split:
        doc.no_of_labourers = split

    doc.total_labour_cost = flt(doc.no_of_labourers) * flt(doc.labour_duration) * flt(doc.wage_per_person)

    # inputs (child table: Farm Activity Input - field names assumed, see notes)
    rows = doc.get("inputs_used") or []
    if rows:
        total = 0
        for row in rows:
            qty, rate = row.get("quantity"), row.get("rate")
            if qty is not None and rate is not None and row.meta.has_field("amount"):
                row.amount = flt(qty) * flt(rate)
            total += flt(row.get("amount"))
        doc.product_cost = total

    doc.total_cost = flt(doc.total_labour_cost) + flt(doc.product_cost) + flt(doc.other_cost)

    if doc.activity_type == "Irrigation" and not doc.irrigation_method:
        frappe.msgprint(_("Irrigation method is not set"), indicator="orange", alert=True)


def farm_activity_on_update(doc, method=None):
    _sync_activity_expenses(doc)
    _update_plot_from_activity(doc)


def farm_activity_on_trash(doc, method=None):
    for name in frappe.get_all("Farm Expense", filters={"source_activity": doc.name}, pluck="name"):
        frappe.delete_doc("Farm Expense", name, ignore_permissions=True, force=True)


def _sync_activity_expenses(doc):
    wanted = {}

    def add(category, amount):
        if flt(amount):
            wanted[category] = wanted.get(category, 0) + flt(amount)

    add("Labour", doc.total_labour_cost)
    add(ACTIVITY_EXPENSE_CATEGORY.get(doc.activity_type, "Other"), doc.product_cost)
    add("Irrigation" if doc.activity_type == "Irrigation" else "Other", doc.other_cost)

    farm = frappe.db.get_value("Plot", doc.plot, "farm") if doc.plot else None
    existing = {
        e.category: e.name
        for e in frappe.get_all("Farm Expense", filters={"source_activity": doc.name}, fields=["name", "category"])
    }

    for category, amount in wanted.items():
        values = {
            "expense_date": doc.activity_date,
            "farmer": doc.farmer,
            "farm": farm,
            "plot": doc.plot,
            "crop_cycle": doc.crop_cycle,
            "category": category,
            "amount": amount,
            "source_activity": doc.name,
            "description": _("Auto-created from {0} ({1})").format(doc.name, doc.activity_type or ""),
        }
        if category in existing:
            frappe.db.set_value("Farm Expense", existing[category], values)
        else:
            frappe.get_doc({"doctype": "Farm Expense", **values}).insert(ignore_permissions=True)

    for category, name in existing.items():
        if category not in wanted:
            frappe.delete_doc("Farm Expense", name, ignore_permissions=True, force=True)


def _update_plot_from_activity(doc):
    if not doc.plot or doc.activity_type not in ("Sowing", "Transplanting") or not doc.crop:
        return
    current = frappe.db.get_value("Plot", doc.plot, "current_crop")
    values = {"current_crop": doc.crop, "sowing_date": doc.activity_date}
    if current and current != doc.crop:
        values["previous_crop"] = current
    frappe.db.set_value("Plot", doc.plot, values)


# --------------------------------------------------------------------------
# Farm Expense (manual entries)
# --------------------------------------------------------------------------
def farm_expense_validate(doc, method=None):
    _fill_from_plot(doc, fill_farm=True)
    if flt(doc.amount) < 0:
        frappe.throw(_("Amount cannot be negative"))


# --------------------------------------------------------------------------
# Field Observation
# --------------------------------------------------------------------------
def field_observation_validate(doc, method=None):
    if doc.field_condition == "Waterlogged":
        doc.waterlogging = 1
    if doc.field_condition in ("Dry", "Cracked"):
        doc.drought_stress = 1


def field_observation_after_insert(doc, method=None):
    """Pest seen in the field -> raise a Crop Health Report automatically."""
    if not doc.pest_occurrence:
        return
    if frappe.db.exists(
        "Crop Health Report",
        {
            "crop_cycle": doc.crop_cycle,
            "plot": doc.plot,
            "report_date": doc.observation_date,
            "issue_type": "Pest",
        },
    ):
        return
    farmer = frappe.db.get_value("Plot", doc.plot, "farmer") if doc.plot else None
    crop = frappe.db.get_value("Crop Cycle", doc.crop_cycle, "crop") if doc.crop_cycle else None
    frappe.get_doc(
        {
            "doctype": "Crop Health Report",
            "report_date": doc.observation_date,
            "crop_cycle": doc.crop_cycle,
            "crop": crop,
            "plot": doc.plot,
            "farmer": farmer,
            "issue_type": "Pest",
            "symptoms": doc.farmer_remarks,
            "severity": "Medium",
            "status": "Under Monitoring",
        }
    ).insert(ignore_permissions=True)
    frappe.msgprint(_("Crop Health Report created from this observation"), alert=True)


# --------------------------------------------------------------------------
# Crop Health Report
# --------------------------------------------------------------------------
def crop_health_report_validate(doc, method=None):
    _fill_from_crop_cycle(doc)
    _fill_from_plot(doc)

    if doc.status != "Resolved" and not doc.follow_up_date:
        base = getdate(doc.report_date or today())
        doc.follow_up_date = add_days(base, FOLLOW_UP_DAYS.get(doc.severity, 7))

    if doc.follow_up_date and doc.report_date and getdate(doc.follow_up_date) < getdate(doc.report_date):
        frappe.throw(_("Follow-up date cannot be before report date"))

    if doc.severity == "High" and flt(doc.affected_area_percent) >= 50 and doc.status in (None, "", "Under Monitoring"):
        doc.status = "Escalated"


def crop_health_report_on_update(doc, method=None):
    if doc.status == "Resolved":
        _close_todos(doc)
        return
    if doc.follow_up_date:
        desc = _("Follow up {0}: {1} on {2}").format(
            doc.name, doc.pest__disease or doc.issue_type or "", doc.plot or doc.crop_cycle or ""
        )
        priority = "High" if doc.severity == "High" or doc.status == "Escalated" else "Medium"
        _create_todo(doc, desc, doc.follow_up_date, priority)


# --------------------------------------------------------------------------
# Harvest Entry
# --------------------------------------------------------------------------
def _sold_qty(harvest_entry):
    return flt(
        frappe.db.sql(
            "select coalesce(sum(quantity_sold),0) from `tabFarm Sale` where harvest_entry=%s and docstatus=1",
            harvest_entry,
        )[0][0]
    )


def harvest_entry_validate(doc, method=None):
    _fill_from_crop_cycle(doc)

    if flt(doc.damaged_quantity) > flt(doc.harvest_quantity):
        frappe.throw(_("Damaged quantity cannot exceed harvest quantity"))

    if doc.crop_cycle and doc.harvest_date:
        start = frappe.db.get_value("Crop Cycle", doc.crop_cycle, "start_date")
        if start and getdate(doc.harvest_date) < getdate(start):
            frappe.throw(_("Harvest date cannot be before the Crop Cycle start date ({0})").format(start))

    if not doc.harvest_number and doc.crop_cycle:
        doc.harvest_number = (
            frappe.db.count("Harvest Entry", {"crop_cycle": doc.crop_cycle, "docstatus": ["<", 2]}) + 1
        )

    doc.usable_quantity = flt(doc.harvest_quantity) - flt(doc.damaged_quantity)
    doc.quantity_sold = _sold_qty(doc.name) if not doc.is_new() else 0
    doc.balance_quantity = flt(doc.usable_quantity) - flt(doc.quantity_sold)


def refresh_harvest_balance(harvest_entry):
    if not harvest_entry:
        return
    usable = flt(frappe.db.get_value("Harvest Entry", harvest_entry, "usable_quantity"))
    sold = _sold_qty(harvest_entry)
    frappe.db.set_value(
        "Harvest Entry",
        harvest_entry,
        {"quantity_sold": sold, "balance_quantity": usable - sold},
        update_modified=False,
    )


# --------------------------------------------------------------------------
# Farm Sale
# --------------------------------------------------------------------------
def farm_sale_validate(doc, method=None):
    if doc.harvest_entry:
        he = frappe.db.get_value(
            "Harvest Entry",
            doc.harvest_entry,
            ["docstatus", "crop_cycle", "plot", "usable_quantity", "uom"],
            as_dict=True,
        )
        if he.docstatus != 1:
            frappe.throw(_("Harvest Entry {0} must be submitted before recording a sale").format(doc.harvest_entry))
        if not doc.crop_cycle:
            doc.crop_cycle = he.crop_cycle
        if not doc.farmer and he.plot:
            doc.farmer = frappe.db.get_value("Plot", he.plot, "farmer")

        already_sold = _sold_qty(doc.harvest_entry)
        # when amending / re-saving a draft this doc is not yet counted (docstatus 0)
        available = flt(he.usable_quantity) - already_sold
        if flt(doc.quantity_sold) > available + 1e-9:
            frappe.throw(
                _("Quantity sold ({0}) exceeds available balance ({1}) of Harvest Entry {2}").format(
                    doc.quantity_sold, available, doc.harvest_entry
                )
            )

    if not doc.farmer and doc.crop_cycle:
        # fall back to farmer from any plot-linked activity of the cycle
        doc.farmer = frappe.db.get_value("Farm Activity", {"crop_cycle": doc.crop_cycle}, "farmer")

    _compute_sale_totals(doc)


def _compute_sale_totals(doc):
    doc.total_value = flt(doc.quantity_sold) * flt(doc.rate_per_unit)
    if flt(doc.amount_received) > flt(doc.total_value) + 0.005:
        frappe.throw(_("Amount received cannot exceed total sales value"))
    if flt(doc.amount_received) <= 0:
        doc.payment_status = "Pending"
    elif flt(doc.amount_received) >= flt(doc.total_value):
        doc.payment_status = "Paid"
    else:
        doc.payment_status = "Partial"


def farm_sale_on_submit(doc, method=None):
    refresh_harvest_balance(doc.harvest_entry)


def farm_sale_on_cancel(doc, method=None):
    refresh_harvest_balance(doc.harvest_entry)


def farm_sale_on_update_after_submit(doc, method=None):
    """Enable 'Allow on Submit' for amount_received & payment_status to use this."""
    _compute_sale_totals(doc)
    frappe.db.set_value(
        "Farm Sale", doc.name, "payment_status", doc.payment_status, update_modified=False
    )


# --------------------------------------------------------------------------
# Crop Cycle summary (used by the JS dashboard)
# --------------------------------------------------------------------------
@frappe.whitelist()
def get_crop_cycle_summary(crop_cycle):
    frappe.has_permission("Crop Cycle", "read", crop_cycle, throw=True)

    expense = flt(frappe.db.sql("select coalesce(sum(amount),0) from `tabFarm Expense` where crop_cycle=%s", crop_cycle)[0][0])
    by_category = frappe.db.sql(
        """select category, coalesce(sum(amount),0) as amount from `tabFarm Expense`
           where crop_cycle=%s group by category order by amount desc""",
        crop_cycle,
        as_dict=True,
    )
    sales = frappe.db.sql(
        """select coalesce(sum(total_value),0) v, coalesce(sum(amount_received),0) r,
                  coalesce(sum(transport_cost),0) t, coalesce(sum(quantity_sold),0) q
           from `tabFarm Sale` where crop_cycle=%s and docstatus=1""",
        crop_cycle,
        as_dict=True,
    )[0]
    harvest = frappe.db.sql(
        """select coalesce(sum(harvest_quantity),0) h, coalesce(sum(usable_quantity),0) u,
                  coalesce(sum(balance_quantity),0) b
           from `tabHarvest Entry` where crop_cycle=%s and docstatus=1""",
        crop_cycle,
        as_dict=True,
    )[0]
    open_issues = frappe.db.count(
        "Crop Health Report", {"crop_cycle": crop_cycle, "status": ["in", ["Under Monitoring", "Escalated"]]}
    )

    total_cost = expense + flt(sales.t)
    return {
        "total_expense": expense,
        "transport_cost": flt(sales.t),
        "expense_by_category": by_category,
        "total_sales": flt(sales.v),
        "amount_received": flt(sales.r),
        "pending_amount": flt(sales.v) - flt(sales.r),
        "net_profit": flt(sales.v) - total_cost,
        "total_harvest": flt(harvest.h),
        "usable_harvest": flt(harvest.u),
        "balance_stock": flt(harvest.b),
        "cost_per_unit": (total_cost / flt(harvest.u)) if flt(harvest.u) else 0,
        "open_health_issues": open_issues,
    }


@frappe.whitelist()
def get_harvest_balance(harvest_entry):
    frappe.has_permission("Harvest Entry", "read", harvest_entry, throw=True)
    return frappe.db.get_value(
        "Harvest Entry",
        harvest_entry,
        ["crop_cycle", "crop", "plot", "balance_quantity", "uom"],
        as_dict=True,
    )


# --------------------------------------------------------------------------
# Scheduler (daily)
# --------------------------------------------------------------------------
def daily_farm_checks():
    # 1) overdue health follow-ups -> escalate if 3+ days late
    for r in frappe.get_all(
        "Crop Health Report",
        filters={"status": "Under Monitoring", "follow_up_date": ["<", add_days(today(), -3)]},
        pluck="name",
    ):
        frappe.db.set_value("Crop Health Report", r, "status", "Escalated")

    # 2) pending / partial payments older than 15 days -> ToDo for the creator
    for s in frappe.get_all(
        "Farm Sale",
        filters={"docstatus": 1, "payment_status": ["in", ["Pending", "Partial"]], "sale_date": ["<", add_days(today(), -15)]},
        fields=["name", "owner", "buyer", "total_value", "amount_received"],
    ):
        if frappe.db.exists("ToDo", {"reference_type": "Farm Sale", "reference_name": s.name, "status": "Open"}):
            continue
        frappe.get_doc(
            {
                "doctype": "ToDo",
                "allocated_to": s.owner,
                "reference_type": "Farm Sale",
                "reference_name": s.name,
                "description": _("Collect payment for {0}: pending {1}").format(
                    s.name, flt(s.total_value) - flt(s.amount_received)
                ),
                "date": today(),
                "priority": "Medium",
            }
        ).insert(ignore_permissions=True)

    frappe.db.commit()