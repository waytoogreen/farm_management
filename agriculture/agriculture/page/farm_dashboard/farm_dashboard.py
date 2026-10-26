"""
Farm Dashboard - data API
Path: apps/agriculture/agriculture/agriculture/page/farm_dashboard/farm_dashboard.py
"""

import frappe
from frappe.utils import date_diff, flt, getdate, today

OPEN_STATUSES = ("Under Monitoring", "Escalated")


def _cycles(farmer, crop_cycle):
    """None = no restriction; list = restrict to these crop cycles."""
    if crop_cycle:
        return [crop_cycle]
    if farmer:
        names = set()
        for dt in ("Farm Activity", "Farm Expense", "Farm Sale"):
            names.update(frappe.get_all(dt, filters={"farmer": farmer, "crop_cycle": ["is", "set"]}, pluck="crop_cycle"))
        return list(names)
    return None


def _cond(cycles, date_field=None, from_date=None, to_date=None, extra=None):
    parts, vals = ["1=1"], {}
    if extra:
        parts.append(extra)
    if cycles is not None:
        if cycles:
            parts.append("crop_cycle in %(cycles)s")
            vals["cycles"] = tuple(cycles)
        else:
            parts.append("1=0")
    if date_field and from_date:
        parts.append(f"{date_field} >= %(from_date)s")
        vals["from_date"] = from_date
    if date_field and to_date:
        parts.append(f"{date_field} <= %(to_date)s")
        vals["to_date"] = to_date
    return " and ".join(parts), vals


@frappe.whitelist()
def get_dashboard_data(farmer=None, crop_cycle=None, from_date=None, to_date=None):
    frappe.has_permission("Crop Cycle", "read", throw=True)
    cycles = _cycles(farmer, crop_cycle)

    def q(sql, vals=None):
        return frappe.db.sql(sql, vals or {}, as_dict=True)

    # ---------------- masters ----------------
    plot_filters = {"farmer": farmer} if farmer else {}
    farmers = 1 if farmer else frappe.db.count("Farmer")
    farms = frappe.db.count("Farm", {"farmer": farmer} if farmer else {})
    plots = frappe.db.count("Plot", plot_filters)
    area = flt(
        q("select coalesce(sum(area),0) a from `tabPlot`" + (" where farmer=%(f)s" if farmer else ""), {"f": farmer})[0].a
    )
    cycle_count = len(cycles) if cycles is not None else frappe.db.count("Crop Cycle")

    # ---------------- expenses ----------------
    c, v = _cond(cycles, "expense_date", from_date, to_date)
    exp_total = flt(q(f"select coalesce(sum(amount),0) t from `tabFarm Expense` where {c}", v)[0].t)
    exp_by_cat = q(
        f"""select coalesce(nullif(category,''),'Uncategorised') category, sum(amount) amount
            from `tabFarm Expense` where {c} group by 1 order by 2 desc""",
        v,
    )
    exp_by_month = q(
        f"""select date_format(expense_date,'%%Y-%%m') m, sum(amount) amount
            from `tabFarm Expense` where {c} and expense_date is not null group by 1""",
        v,
    )
    exp_by_cycle = {
        r.crop_cycle: flt(r.amount)
        for r in q(f"select crop_cycle, sum(amount) amount from `tabFarm Expense` where {c} group by 1", v)
    }

    # ---------------- sales ----------------
    c, v = _cond(cycles, "sale_date", from_date, to_date, "docstatus=1")
    sales = q(
        f"""select coalesce(sum(total_value),0) value, coalesce(sum(amount_received),0) received,
                   coalesce(sum(transport_cost),0) transport, coalesce(sum(quantity_sold),0) qty
            from `tabFarm Sale` where {c}""",
        v,
    )[0]
    sales_by_month = q(
        f"""select date_format(sale_date,'%%Y-%%m') m, sum(total_value) amount
            from `tabFarm Sale` where {c} and sale_date is not null group by 1""",
        v,
    )
    pay_status = q(
        f"""select coalesce(nullif(payment_status,''),'Pending') status, count(*) cnt,
                   sum(total_value - amount_received) pending
            from `tabFarm Sale` where {c} group by 1""",
        v,
    )
    sales_by_cycle = {
        r.crop_cycle: r
        for r in q(
            f"""select crop_cycle, sum(total_value) value, sum(transport_cost) transport
                from `tabFarm Sale` where {c} group by 1""",
            v,
        )
    }
    pending_sales = q(
        f"""select name, farmer, sale_date, total_value, amount_received, payment_status
            from `tabFarm Sale` where {c} and payment_status in ('Pending','Partial')
            order by sale_date asc limit 8""",
        v,
    )
    for r in pending_sales:
        r["pending"] = flt(r.total_value) - flt(r.amount_received)
        r["days"] = date_diff(today(), r.sale_date) if r.sale_date else 0

    # ---------------- harvest ----------------
    c, v = _cond(cycles, "harvest_date", from_date, to_date, "docstatus=1")
    harvest_tot = q(
        f"""select coalesce(sum(harvest_quantity),0) h, coalesce(sum(damaged_quantity),0) d,
                   coalesce(sum(usable_quantity),0) u, coalesce(sum(balance_quantity),0) b
            from `tabHarvest Entry` where {c}""",
        v,
    )[0]
    harvest_by_crop = q(
        f"""select coalesce(nullif(crop,''),'Unknown') crop, sum(usable_quantity) usable,
                   sum(quantity_sold) sold, sum(balance_quantity) balance
            from `tabHarvest Entry` where {c} group by 1 order by 2 desc limit 8""",
        v,
    )
    usable_by_cycle = {
        r.crop_cycle: flt(r.u)
        for r in q(f"select crop_cycle, sum(usable_quantity) u from `tabHarvest Entry` where {c} group by 1", v)
    }

    # ---------------- crop health (open issues ignore the date range) ----------------
    c, v = _cond(cycles)
    open_c = c + " and status in %(open)s"
    v_open = {**v, "open": OPEN_STATUSES}
    health_by_sev = q(
        f"""select coalesce(nullif(severity,''),'Unrated') severity, count(*) cnt
            from `tabCrop Health Report` where {open_c} group by 1""",
        v_open,
    )
    health_open = q(
        f"""select name, report_date, issue_type, pest__disease, severity, status, plot, follow_up_date
            from `tabCrop Health Report` where {open_c}
            order by follow_up_date asc limit 8""",
        v_open,
    )
    for r in health_open:
        r["overdue"] = bool(r.follow_up_date and getdate(r.follow_up_date) < getdate(today()))
    open_issues = sum(r.cnt for r in health_by_sev)

    # ---------------- field conditions ----------------
    c, v = _cond(cycles, "observation_date", from_date, to_date)
    field = q(
        f"""select coalesce(sum(rainfall_mm),0) rain, coalesce(sum(waterlogging),0) waterlogging,
                   coalesce(sum(drought_stress),0) drought, coalesce(sum(pest_occurrence),0) pest,
                   count(*) obs from `tabField Observation` where {c}""",
        v,
    )[0]

    # ---------------- recent activities ----------------
    c, v = _cond(cycles, "activity_date", from_date, to_date)
    activities = q(
        f"""select name, activity_date, activity_type, crop, plot, total_cost
            from `tabFarm Activity` where {c} order by activity_date desc, creation desc limit 8""",
        v,
    )
    labour_total = flt(q(f"select coalesce(sum(total_labour_cost),0) t from `tabFarm Activity` where {c}", v)[0].t)

    # ---------------- crop cycle profitability ----------------
    cycle_filters = {"name": ["in", cycles]} if cycles else {}
    cycle_rows = []
    if cycles is None or cycles:
        for cy in frappe.get_all(
            "Crop Cycle",
            filters=cycle_filters,
            fields=["name", "crop", "start_date"],
            order_by="start_date desc",
            limit=30,
        ):
            sr = sales_by_cycle.get(cy.name)
            sale_val = flt(sr.value) if sr else 0
            transport = flt(sr.transport) if sr else 0
            expense = exp_by_cycle.get(cy.name, 0)
            usable = usable_by_cycle.get(cy.name, 0)
            cost = expense + transport
            cycle_rows.append(
                {
                    "name": cy.name,
                    "crop": cy.crop,
                    "start_date": cy.start_date,
                    "expense": expense,
                    "sales": sale_val,
                    "profit": sale_val - cost,
                    "margin": ((sale_val - cost) / sale_val * 100) if sale_val else 0,
                    "usable": usable,
                    "cost_per_unit": (cost / usable) if usable else 0,
                }
            )
        cycle_rows.sort(key=lambda r: r["profit"], reverse=True)

    months = sorted({r.m for r in exp_by_month} | {r.m for r in sales_by_month})
    em = {r.m: flt(r.amount) for r in exp_by_month}
    sm = {r.m: flt(r.amount) for r in sales_by_month}

    total_cost = exp_total + flt(sales.transport)
    return {
        "kpis": {
            "farmers": farmers,
            "farms": farms,
            "plots": plots,
            "area": area,
            "cycles": cycle_count,
            "expense": exp_total,
            "labour": labour_total,
            "sales": flt(sales.value),
            "received": flt(sales.received),
            "pending": flt(sales.value) - flt(sales.received),
            "transport": flt(sales.transport),
            "net_profit": flt(sales.value) - total_cost,
            "margin": ((flt(sales.value) - total_cost) / flt(sales.value) * 100) if flt(sales.value) else 0,
            "harvest": flt(harvest_tot.h),
            "damaged": flt(harvest_tot.d),
            "usable": flt(harvest_tot.u),
            "balance": flt(harvest_tot.b),
            "sold_qty": flt(sales.qty),
            "open_issues": open_issues,
            "rain": flt(field.rain),
        },
        "field": {k: flt(field[k]) for k in ("waterlogging", "drought", "pest", "obs")},
        "expense_by_category": exp_by_cat,
        "monthly": {
            "labels": months,
            "expense": [em.get(m, 0) for m in months],
            "sales": [sm.get(m, 0) for m in months],
        },
        "payment_status": pay_status,
        "harvest_by_crop": harvest_by_crop,
        "health_by_severity": health_by_sev,
        "health_open": health_open,
        "activities": activities,
        "cycles": cycle_rows[:12],
        "pending_sales": pending_sales,
    }