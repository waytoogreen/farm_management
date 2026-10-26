"""
Sample data + end-to-end check for the Crop Management flow.

Place at:  apps/agriculture/agriculture/seed_flow_test.py
Run from frappe-bench:
    bench --site <your-site> execute agriculture.seed_flow_test.run
    bench --site <your-site> execute agriculture.seed_flow_test.cleanup     # remove test data

Each check prints PASS / FAIL with expected vs actual.
"""

import frappe
from frappe.utils import add_days, flt, today

PREFIX = "TEST-"
results = []


def check(label, actual, expected):
    ok = (flt(actual) == flt(expected)) if isinstance(expected, (int, float)) else (actual == expected)
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected={expected} actual={actual}")


def get_or_create(doctype, filters, values):
    name = frappe.db.get_value(doctype, filters, "name")
    if name:
        return frappe.get_doc(doctype, name)
    doc = frappe.get_doc({"doctype": doctype, **filters, **values})
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    return doc


def run():
    frappe.set_user("Administrator")

    # ---------------- masters ----------------
    if not frappe.db.exists("UOM", "Kg"):
        frappe.get_doc({"doctype": "UOM", "uom_name": "Kg"}).insert(ignore_permissions=True)

    crop = get_or_create(
        "Crop",
        {"title": PREFIX + "Tomato"},
        {
            "crop_name": PREFIX + "Tomato",
            "type": "Annual",
            "period": 120,
            "agriculture_task": [
                {"task_name": "Land prep", "start_day": 1, "end_day": 3, "holiday_management": "Ignore holidays"},
            ],
        },
    )

    farmer = get_or_create(
        "Farmer",
        {"farmer_name": PREFIX + "Ramesh"},
        {"village": "Kovilpatti", "district": "Thoothukudi", "mobile_number": "+91-9876543210",
         "total_land_area": 5, "soil_type": "Red", "irrigation_source": "Borewell", "farming_type": "Organic"},
    )
    farm = get_or_create("Farm", {"farm_name": PREFIX + "North Farm", "farmer": farmer.name}, {"total_area": 5})
    plot = get_or_create(
        "Plot",
        {"farm": farm.name, "survey_number": PREFIX + "SY-101"},
        {"area": 2, "area_uom": "Acre", "soil_type": "Red", "cultivation_method": "Organic"},
    )

    seed_item = get_or_create(
        "Farm Input Item",
        {"input_name": PREFIX + "Tomato Seed"},
        {"input_category": "Seed", "uom": "Kg", "default_rate": 200, "supplier": "Local Agro"},
    )

    cycle = get_or_create(
        "Crop Cycle",
        {"title": PREFIX + "Tomato Cycle 1"},
        {"crop": crop.name, "start_date": add_days(today(), -30), "cycle_type": "Less than a year"},
    )
    print("Masters ready:", farmer.name, farm.name, plot.name, cycle.name)

    # ---------------- 1. Farm Activity: Sowing ----------------
    act = frappe.get_doc(
        {
            "doctype": "Farm Activity",
            "activity_date": add_days(today(), -28),
            "crop_cycle": cycle.name,
            "plot": plot.name,
            "activity_type": "Sowing",
            "male_workers": 2,
            "female_workers": 3,
            "labour_duration": 1,
            "labour_uom": "Days",
            "wage_per_person": 500,
            "other_cost": 300,
        }
    )
    child_meta = frappe.get_meta("Farm Activity Input")
    if all(child_meta.has_field(f) for f in ("input_item", "quantity", "rate")):
        act.append("inputs_used", {"input_item": seed_item.name, "quantity": 10, "rate": 200})
    else:
        print("NOTE: Farm Activity Input fields differ from input_item/quantity/rate -> setting product_cost directly")
        act.product_cost = 2000
    act.insert(ignore_permissions=True)

    check("Activity auto-fill crop", act.crop, crop.name)
    check("Activity auto-fill farmer from plot", act.farmer, farmer.name)
    check("Activity no_of_labourers", act.no_of_labourers, 5)
    check("Activity labour cost", act.total_labour_cost, 2500)
    check("Activity product cost", act.product_cost, 2000)
    check("Activity total cost", act.total_cost, 4800)

    exp = {e.category: e.amount for e in frappe.get_all("Farm Expense", filters={"source_activity": act.name}, fields=["category", "amount"])}
    check("Expense Labour", exp.get("Labour"), 2500)
    check("Expense Seeds", exp.get("Seeds"), 2000)
    check("Expense Other", exp.get("Other"), 300)

    plot.reload()
    check("Plot current_crop updated", plot.current_crop, crop.name)

    # ---------------- 2. Farm Activity: Irrigation ----------------
    irr = frappe.get_doc(
        {
            "doctype": "Farm Activity",
            "activity_date": add_days(today(), -20),
            "crop_cycle": cycle.name,
            "plot": plot.name,
            "activity_type": "Irrigation",
            "irrigation_method": "Drip",
            "duration_hours": 4,
            "water_source": "Borewell",
            "no_of_labourers": 2,
            "labour_duration": 4,
            "labour_uom": "Hours",
            "wage_per_person": 50,
            "other_cost": 100,
        }
    ).insert(ignore_permissions=True)
    check("Irrigation labour cost", irr.total_labour_cost, 400)
    check("Irrigation total cost", irr.total_cost, 500)
    irr_exp = frappe.db.get_value("Farm Expense", {"source_activity": irr.name, "category": "Irrigation"}, "amount")
    check("Irrigation expense category", irr_exp, 100)

    # edit activity -> expenses must re-sync
    act.reload()
    act.wage_per_person = 600
    act.save(ignore_permissions=True)
    check("Re-sync: Labour expense after edit", frappe.db.get_value("Farm Expense", {"source_activity": act.name, "category": "Labour"}, "amount"), 3000)
    act.wage_per_person = 500
    act.save(ignore_permissions=True)

    # ---------------- 3. Field Observation (pest) -> Crop Health Report ----------------
    obs_date = add_days(today(), -10)
    obs = frappe.get_doc(
        {
            "doctype": "Field Observation",
            "observation_date": obs_date,
            "crop_cycle": cycle.name,
            "plot": plot.name,
            "field_condition": "Cracked",
            "pest_occurrence": 1,
            "rainfall_mm": 0,
            "temperature_c": 38,
            "farmer_remarks": "Leaf curling seen on lower leaves",
        }
    ).insert(ignore_permissions=True)
    check("Observation drought flag", obs.drought_stress, 1)
    chr_name = frappe.db.get_value("Crop Health Report", {"crop_cycle": cycle.name, "report_date": obs_date, "issue_type": "Pest"})
    check("Health report auto-created", bool(chr_name), True)

    # ---------------- 4. Crop Health Report escalation + ToDo ----------------
    rep = frappe.get_doc(
        {
            "doctype": "Crop Health Report",
            "report_date": add_days(today(), -9),
            "crop_cycle": cycle.name,
            "plot": plot.name,
            "issue_type": "Disease",
            "pest__disease": "Early blight",
            "severity": "High",
            "affected_area_percent": 60,
            "status": "Under Monitoring",
        }
    ).insert(ignore_permissions=True)
    check("Report farmer filled", rep.farmer, farmer.name)
    check("Report follow-up = date+2 (High)", str(rep.follow_up_date), str(add_days(rep.report_date, 2)))
    check("Report auto-escalated", rep.status, "Escalated")
    check("ToDo created", bool(frappe.db.exists("ToDo", {"reference_type": "Crop Health Report", "reference_name": rep.name, "status": "Open"})), True)
    rep.status = "Resolved"
    rep.save(ignore_permissions=True)
    check("ToDo closed on resolve", bool(frappe.db.exists("ToDo", {"reference_type": "Crop Health Report", "reference_name": rep.name, "status": "Open"})), False)

    # ---------------- 5. Harvest Entry ----------------
    he = frappe.get_doc(
        {
            "doctype": "Harvest Entry",
            "harvest_date": today(),
            "crop_cycle": cycle.name,
            "plot": plot.name,
            "harvest_quantity": 1000,
            "damaged_quantity": 100,
            "uom": "Kg",
            "grade": "A",
        }
    ).insert(ignore_permissions=True)
    check("Harvest crop fetched", he.crop, crop.name)
    check("Harvest number", he.harvest_number, 1)
    check("Harvest usable", he.usable_quantity, 900)
    check("Harvest balance (before sale)", he.balance_quantity, 900)
    he.submit()

    # ---------------- 6. Farm Sale ----------------
    sale = frappe.get_doc(
        {
            "doctype": "Farm Sale",
            "sale_date": today(),
            "harvest_entry": he.name,
            "market_location": "Kovilpatti Mandi",
            "quantity_sold": 400,
            "rate_per_unit": 30,
            "transport_cost": 500,
            "amount_received": 5000,
        }
    ).insert(ignore_permissions=True)
    check("Sale crop_cycle fetched", sale.crop_cycle, cycle.name)
    check("Sale farmer fetched", sale.farmer, farmer.name)
    check("Sale total value", sale.total_value, 12000)
    check("Sale payment status", sale.payment_status, "Partial")
    sale.submit()

    he.reload()
    check("Harvest quantity_sold after sale", he.quantity_sold, 400)
    check("Harvest balance after sale", he.balance_quantity, 500)

    # oversell must fail
    try:
        frappe.get_doc(
            {"doctype": "Farm Sale", "sale_date": today(), "harvest_entry": he.name,
             "quantity_sold": 600, "rate_per_unit": 30}
        ).insert(ignore_permissions=True)
        check("Oversell blocked", "allowed", "blocked")
    except frappe.ValidationError:
        check("Oversell blocked", "blocked", "blocked")

    # cancel -> stock restored
    sale.cancel()
    he.reload()
    check("Balance restored after cancel", he.balance_quantity, 900)
    sale2 = frappe.copy_doc(sale)
    sale2.docstatus = 0
    sale2.amended_from = None
    sale2.insert(ignore_permissions=True)
    sale2.submit()

    # ---------------- 7. Crop Cycle summary ----------------
    from agriculture.farm_automation import get_crop_cycle_summary

    s = get_crop_cycle_summary(cycle.name)
    check("Summary total expense", s["total_expense"], 5300)
    check("Summary total sales", s["total_sales"], 12000)
    check("Summary transport", s["transport_cost"], 500)
    check("Summary net profit", s["net_profit"], 6200)
    check("Summary pending", s["pending_amount"], 7000)
    check("Summary stock balance", s["balance_stock"], 500)

    frappe.db.commit()
    print(f"\n{sum(results)}/{len(results)} checks passed")


def cleanup():
    frappe.set_user("Administrator")
    order = [
        ("Farm Sale", "market_location", "Kovilpatti Mandi"),
    ]
    cycles = frappe.get_all("Crop Cycle", filters={"title": ["like", PREFIX + "%"]}, pluck="name")
    for dt in ("Farm Sale", "Harvest Entry"):
        for n in frappe.get_all(dt, filters={"crop_cycle": ["in", cycles]}, fields=["name", "docstatus"]):
            doc = frappe.get_doc(dt, n.name)
            if doc.docstatus == 1:
                doc.cancel()
            frappe.delete_doc(dt, n.name, force=True, ignore_permissions=True)
    for dt in ("Crop Health Report", "Field Observation", "Farm Expense", "Farm Activity"):
        for n in frappe.get_all(dt, filters={"crop_cycle": ["in", cycles]}, pluck="name"):
            frappe.delete_doc(dt, n, force=True, ignore_permissions=True)
    for n in cycles:
        frappe.delete_doc("Crop Cycle", n, force=True, ignore_permissions=True)
    farmers = frappe.get_all("Farmer", filters={"farmer_name": ["like", PREFIX + "%"]}, pluck="name")
    for dt, flt_ in (("Plot", {"farmer": ["in", farmers]}), ("Farm", {"farmer": ["in", farmers]})):
        for n in frappe.get_all(dt, filters=flt_, pluck="name"):
            frappe.delete_doc(dt, n, force=True, ignore_permissions=True)
    for n in farmers:
        frappe.delete_doc("Farmer", n, force=True, ignore_permissions=True)
    for dt, fld in (("Farm Input Item", "input_name"), ("Crop", "title")):
        for n in frappe.get_all(dt, filters={fld: ["like", PREFIX + "%"]}, pluck="name"):
            frappe.delete_doc(dt, n, force=True, ignore_permissions=True)
    frappe.db.commit()
    for p in frappe.get_all("Project", filters={"project_name": ["like", PREFIX + "%"]}, pluck="name"):
        for t in frappe.get_all("Task", filters={"project": p}, pluck="name"):
            frappe.delete_doc("Task", t, force=True, ignore_permissions=True)
        frappe.delete_doc("Project", p, force=True, ignore_permissions=True)
    print("Test data removed")