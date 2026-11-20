#!/usr/bin/env python3
"""
Build the user's manual:

    python tools/make_guide.py

Writes "Wx Router Users Manual.docx" in the project folder, then uses LibreOffice
(if installed) to make the .doc and .pdf copies. Screenshots come from
tools/screens/ (made by tools/shoot.py from tools/shot.html). Needs python-docx.
"""
import os
import subprocess
from datetime import date

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

ADDRESS = "https://jlblan2.github.io/wx-router/"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
SCREENS = os.path.join(HERE, "screens")
OUT = os.path.join(ROOT, "Wx Router Users Manual.docx")
SOFFICE = r"C:\Program Files\LibreOffice\program\soffice.exe"
# The worked example (section 11) describes the passage in the pictures; update these when the
# screens are photographed again (tools/shoot.py), since the forecast changes every day.
EXAMPLE_DATE = "November 20, 2026"
EXAMPLE_RESULT = ("That evening the direct line was within the limits: 49.0 nm and 2 h 48 min underway, "
                  "the worst seas 3.4 ft at 8 seconds on the port beam, 68% of the 5 ft limit for that "
                  "direction, and nothing shallower than 15 ft. Had the start been over the limits, the card "
                  "would have said “Not yet: wait to leave” and given the first time it wouldn’t be.")

NAVY = RGBColor(0x0A, 0x2A, 0x4A)
TEAL = RGBColor(0x0E, 0x7C, 0x72)
GREY = RGBColor(0x55, 0x5F, 0x6B)
FONT = "Arial"

doc = Document()

# ── page and styles ──────────────────────────────────────────────────────────
sec = doc.sections[0]
sec.page_width, sec.page_height = Inches(8.5), Inches(11)
sec.left_margin = sec.right_margin = Inches(1)
sec.top_margin = sec.bottom_margin = Inches(0.9)


def style(name, size, bold=False, color=None, before=0, after=6, keep=False):
    s = doc.styles[name]
    s.font.name = FONT
    s.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    s.font.size = Pt(size)
    s.font.bold = bold
    s.font.italic = False
    if color is not None:
        s.font.color.rgb = color
    pf = s.paragraph_format
    pf.space_before, pf.space_after = Pt(before), Pt(after)
    pf.keep_with_next = keep
    return s


style("Normal", 11, after=6).paragraph_format.line_spacing = 1.12
style("Title", 28, bold=True, color=NAVY, after=4)
style("Subtitle", 14, color=TEAL, after=18)
style("Heading 1", 18, bold=True, color=NAVY, before=18, after=8, keep=True)
style("Heading 2", 14, bold=True, color=TEAL, before=14, after=6, keep=True)
style("Heading 3", 12, bold=True, color=NAVY, before=10, after=4, keep=True)
style("List Bullet", 11, after=3)
style("Caption", 9, color=GREY, after=10)


def para(text="", bold_lead=None, style_name=None, align=None, after=None, italic=False, color=None):
    """A paragraph. bold_lead is put in bold in front of the text."""
    p = doc.add_paragraph(style=style_name)
    if bold_lead:
        p.add_run(bold_lead).bold = True
    r = p.add_run(text)
    r.italic = italic
    if color is not None:
        r.font.color.rgb = color
    if align is not None:
        p.alignment = align
    if after is not None:
        p.paragraph_format.space_after = Pt(after)
    return p


def h1(text):
    return doc.add_heading(text, level=1)


def h2(text):
    return doc.add_heading(text, level=2)


def h3(text):
    return doc.add_heading(text, level=3)


def bullets(items):
    for item in items:
        p = doc.add_paragraph(style="List Bullet")
        if isinstance(item, tuple):
            p.add_run(item[0]).bold = True
            p.add_run(item[1])
        else:
            p.add_run(item)


def steps(items):
    """Numbered steps, typed out so every list starts again at 1."""
    for i, item in enumerate(items, 1):
        p = doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent, pf.first_line_indent = Inches(0.35), Inches(-0.3)
        pf.space_after = Pt(4)
        p.add_run(f"{i}.").bold = True
        p.add_run("\t")
        pf.tab_stops.add_tab_stop(Inches(0.35))
        if isinstance(item, tuple):
            p.add_run(item[0]).bold = True
            p.add_run(item[1])
        else:
            p.add_run(item)


def shade(cell, hex_fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tc_pr.append(shd)


def cell_margins(table, top=70, bottom=70, left=110, right=110):
    tbl_pr = table._tbl.tblPr
    mar = OxmlElement("w:tblCellMar")
    for side, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        el = OxmlElement(f"w:{side}")
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tbl_pr.append(mar)


def note(text, lead="Note: ", fill="FFF4D6"):
    """A shaded one-cell box for warnings and tips."""
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.style = "Table Grid"
    cell_margins(t, 90, 90, 140, 140)
    cant = OxmlElement("w:cantSplit")             # keep the box on one page
    cant.set(qn("w:val"), "true")
    t.rows[0]._tr.get_or_add_trPr().append(cant)
    c = t.rows[0].cells[0]
    c.width = Inches(6.5)
    shade(c, fill)
    p = c.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    p.add_run(lead).bold = True
    p.add_run(text)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def table(headers, rows, widths):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    cell_margins(t)
    for i, text in enumerate(headers):
        c = t.rows[0].cells[i]
        c.width = Inches(widths[i])
        shade(c, "0A2A4A")
        p = c.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        r = p.add_run(text)
        r.bold = True
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    for n, row in enumerate(rows):
        new_row = t.add_row()
        cant = OxmlElement("w:cantSplit")          # never break a row across two pages
        cant.set(qn("w:val"), "true")
        new_row._tr.get_or_add_trPr().append(cant)
        cells = new_row.cells
        for i, text in enumerate(row):
            cells[i].width = Inches(widths[i])
            if n % 2:
                shade(cells[i], "F1F5F9")
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            r = p.add_run(text)
            if i == 0:
                r.bold = True
    # repeat the header row on each page
    tr_pr = t.rows[0]._tr.get_or_add_trPr()
    hdr = OxmlElement("w:tblHeader")
    hdr.set(qn("w:val"), "true")
    tr_pr.append(hdr)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def screens(items, width=2.25):
    """Screenshots side by side with captions underneath. items = [(file, caption), ...]"""
    t = doc.add_table(rows=2, cols=len(items))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, (name, caption) in enumerate(items):
        c = t.rows[0].cells[i]
        p = c.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.keep_with_next = True
        p.add_run().add_picture(os.path.join(SCREENS, name + ".jpg"), width=Inches(width))
        cp = t.rows[1].cells[i].paragraphs[0]
        cp.style = doc.styles["Caption"]
        cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cp.add_run(caption)
    for row in t.rows:                      # keep picture and caption on one page
        tr_pr = row._tr.get_or_add_trPr()
        cant = OxmlElement("w:cantSplit")
        cant.set(qn("w:val"), "true")
        tr_pr.append(cant)


def page_break():
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def add_field(paragraph, instr):
    run = paragraph.add_run()
    for kind, text in (("begin", None), (None, instr), ("end", None)):
        if kind:
            el = OxmlElement("w:fldChar")
            el.set(qn("w:fldCharType"), kind)
        else:
            el = OxmlElement("w:instrText")
            el.set(qn("xml:space"), "preserve")
            el.text = text
        run._r.append(el)
    return run


# footer: title on the left, page number on the right
fp = sec.footer.paragraphs[0]
fp.paragraph_format.tab_stops.add_tab_stop(Inches(6.5), alignment=2)
r = fp.add_run("Wx Router – User's Manual\tPage ")
r.font.size = Pt(9)
r.font.color.rgb = GREY
add_field(fp, "PAGE").font.size = Pt(9)

# ── title page ───────────────────────────────────────────────────────────────
doc.add_paragraph()
doc.add_paragraph("Wx Router", style="Title")
doc.add_paragraph("User’s Manual for iPhone and Android", style="Subtitle")
para(f"Manual dated {date.today().strftime('%B %d, %Y').replace(' 0', ' ')}", color=GREY)
para("")
para("Wx Router plans a boat passage that stays inside your own limits. You tell it how much sea and wind your "
     "boat and crew will take from each direction, how deep the water must be, and how fast you cruise. It then "
     "finds the quickest route that keeps within those limits the whole way, using the latest marine forecast, "
     "water depths, the coastline and bridges. It also shows which departure hours in the coming days work, "
     "where you could shelter along the way, and exports the route to your chartplotter.")
para("The app address is:")
para(ADDRESS, align=WD_ALIGN_PARAGRAPH.CENTER).runs[0].bold = True
para("")
note("Wx Router is a planning aid only. Forecasts can be wrong, depth data is not a chart, and conditions on the "
     "water change. The captain is responsible for the safety of the crew and the safe navigation of the boat. "
     "Check every route against an official chart, the National Weather Service forecast and your own judgment.",
     lead="Important: ")
h3("In this manual")
for line in [
    "1.  Installing Wx Router",
    "2.  Finding your way around",
    "3.  Setting up your boat",
    "4.  Planning a route",
    "5.  Reading the route",
    "6.  When can you go?",
    "7.  When there is no route",
    "8.  Safe havens and anchorages",
    "9.  Saved routes",
    "10. Exporting, printing, clearing and closing",
    "11. A worked example",
    "12. Troubleshooting",
    "13. Your data, updates and removing the app",
    "14. What the app is based on, and its limits",
]:
    para(line, after=1).paragraph_format.left_indent = Inches(0.25)
page_break()

# ── 1 ────────────────────────────────────────────────────────────────────────
h1("1.  Installing Wx Router")
para("Wx Router is a web app. It does not come from the App Store or Google Play. You open its web page once, "
     "add it to your Home Screen, and from then on it opens like any other app. Do the install where you have a "
     "good internet connection; it takes about a minute.")
h2("iPhone or iPad")
steps([
    ("Open Safari ", "and go to  " + ADDRESS),
    ("Tap the Share button ", "(the square with an arrow pointing up). On an iPhone it is at the bottom of the "
     "screen; on an iPad it is at the top."),
    ("Scroll down the list and tap “Add to Home Screen”. ", "If you do not see it, scroll to the bottom, tap "
     "“Edit Actions…” and add it."),
    ("Tap “Add” ", "(top right)."),
    ("Close Safari. ", "Find the Wx Router icon on your Home Screen and tap it."),
])
h2("Android phone")
steps([
    ("Open Chrome ", "and go to  " + ADDRESS),
    ("Tap the menu ", "(three dots, top right)."),
    ("Tap “Add to Home screen” or “Install app” ", "(the wording depends on the version of Chrome), then tap "
     "“Install”."),
    ("Find the Wx Router icon ", "on your Home screen or in the app drawer and tap it."),
])
h2("The first time you open it")
steps([
    ("Read the disclaimer ", "and tap “I understand and accept”. It is asked only once."),
    ("The Settings screen opens. ", "Enter your boat and its limits (section 3) and tap Save settings. You only "
     "need to do this once; the settings stay on the phone."),
    ("Allow Location ", "if you want to use “My location” as the start of a route. The phone asks the first time "
     "you tap it."),
])
note("Wx Router needs an internet connection to plan a route: it downloads the forecast, depths, coastline "
     "details and harbour data each time. Plan before you lose signal. The app itself and this manual open "
     "with no signal.", lead="Good to know: ")

# ── 2 ────────────────────────────────────────────────────────────────────────
h1("2.  Finding your way around")
para("The bar along the top of the screen has everything you need to move around:")
table(["Item", "What it does"], [
    ["Wx Router", "The app name. Once settings are saved, your boat’s name, length and cruise speed are shown "
                  "next to it (with a sailboat symbol for a sailing vessel)."],
    ["Route", "The chart and route planner. This is the main screen."],
    ["Settings", "Your boat, its limits, the weather source, this manual and the disclaimer."],
    ["✕", "Closes the app (section 10)."],
], [1.4, 5.1])
para("The Route screen has the chart at the top and the route planner below it; scroll down for the results. "
     "On the chart:")
bullets([
    ("Pinch, or use + and −, ", "to zoom, and drag to move the chart."),
    ("The layers button ", "(bottom left) turns the OpenSeaMap chart symbols on and off: buoys, lights, rocks, "
     "wrecks and other aids. They appear once you zoom in."),
    ("Clear ", "(top right) removes the start, destination, waypoints and route."),
    ("Markers: ", "S is the start (green), D the destination (red), and numbered blue markers are your own "
     "waypoints. Small dots on a planned route are course changes; tap one to see its name and time."),
])

# ── 3 ────────────────────────────────────────────────────────────────────────
h1("3.  Setting up your boat")
para("Open Settings, fill in each section, and tap Save settings at the bottom. “Saved.” appears briefly when "
     "they are stored. Every route uses these settings, so check them before planning a passage, especially if "
     "the crew or the load has changed.")
screens([("first", "Vessel details"), ("settings-limits", "Sea limits by direction")], width=2.4)
h2("Vessel")
table(["Setting", "What it means"], [
    ["Vessel name", "Shown on the routes and printouts. Optional."],
    ["Vessel type", "Motor or Sail. Sail adds two more settings (below)."],
    ["Length, Freeboard", "Stored for your records. They do not change the routing yet."],
    ["Draft", "For your records; use it to choose the minimum water depth."],
    ["Air draft", "Height from the waterline to the top of the mast or arch. Routes only pass under a fixed "
                  "bridge whose charted clearance is at least 1 ft more. Fixed bridges with no charted "
                  "clearance are avoided; opening bridges are allowed."],
    ["Minimum water depth", "Routes stay out of water shallower than this. The depth data is measured from "
                            "about high water, not chart datum, and small shoals can be missed, so leave a "
                            "margin: draft plus 3 ft is a sensible start. Default 6 ft."],
    ["Keep off land", "Legs stay at least this far from the coastline, so a route does not clip a point or a "
                      "reef edge. The first and last 2 nm at your start, destination and waypoints are exempt, "
                      "so harbours can still be reached. Default 0.5 nm."],
    ["Cruise speed", "Your speed through the water, in knots. Used for every time and arrival. Default 8 kt."],
], [1.6, 4.9])
h2("Maximum seas and winds, by direction")
para("This is the heart of Wx Router. Most boats take a head sea much worse than a following sea, and a beam "
     "sea differently again, so you set a limit for each of eight directions around the boat, each covering 45°. "
     "The diagram shows the boat from above with the bow at the top, with each wedge labelled with its limit; "
     "it updates as you type.")
table(["Direction", "Seas or wind arriving from", "Default seas", "Default wind"], [
    ["Bow", "dead ahead (0°)", "4 ft", "20 kt"],
    ["Starboard bow", "45° to starboard", "4.5 ft", "22 kt"],
    ["Starboard beam", "90° to starboard", "5 ft", "25 kt"],
    ["Starboard quarter", "135° to starboard", "5 ft", "25 kt"],
    ["Stern", "dead astern (180°)", "4 ft", "25 kt"],
    ["Port quarter", "135° to port (225°)", "5 ft", "25 kt"],
    ["Port beam", "90° to port (270°)", "5 ft", "25 kt"],
    ["Port bow", "45° to port (315°)", "4.5 ft", "22 kt"],
], [1.5, 2.2, 1.4, 1.4])
para("Seas are the forecast significant wave height (the average of the highest third of the waves; some "
     "waves will be bigger). Wind is the forecast sustained wind, not gusts. The direction is worked out for "
     "each leg from the course the boat is steering at that time, so the same seas can be fine on one leg and "
     "over the limit on the next.")
note("Start with numbers you would be comfortable with on an ordinary day, not the most the boat can survive. "
     "You can loosen them for a particular passage and put them back afterwards.", lead="Tip: ")
screens([("settings-more", "Steep seas, cruising hours, weather"), ("sail", "Sailing vessel options")], width=2.4)
h2("Steep, short seas")
para("Short, steep waves are uncomfortable and dangerous whatever their direction. Wx Router avoids any area "
     "where the waves are higher than “Wave height over” and come “Period at or under” seconds apart or closer. "
     "The defaults are 6 ft and 6 seconds.")
h2("Cruising hours")
para("Tick “Don’t cruise during set hours” to keep the boat off the water during part of the day, for example "
     "18:00 until 08:00 to avoid running at night. Times are the phone’s local time. A departure only works if "
     "the boat leaves and arrives outside those hours. On a passage too long for one day, add your own waypoints "
     "where you can anchor: the route stops overnight at one and goes on the next morning.")
h2("Sailing vessels")
para("With Vessel type set to Sail, two more settings appear. Legs pointing closer to the wind than “Closest to "
     "the wind” (default 45°) are avoided once the wind reaches “Once wind is at least” (default 8 kt), so the "
     "route reaches or tacks across the wind instead of heading straight into it. The first leg out of the "
     "start and the last leg into the destination are exempt, since those are usually motored.")
h2("Weather data")
bullets([
    ("Forecast source: ", "“Open-Meteo marine + weather forecast” is the real forecast and should normally be "
     "used. “Demo data” is made-up weather for trying the app; never plan a real passage with it."),
    ("Open-Meteo API key: ", "leave it blank. The free service allows about 10,000 forecast points a day and a "
     "long route uses several hundred, which is plenty for normal use. If you buy an Open-Meteo subscription, "
     "paste its key here to remove the limits. The key stays on the phone."),
])
h2("At the bottom of Settings")
bullets([
    ("Save settings ", "stores everything above."),
    ("User’s manual (PDF) ", "opens this manual. It is stored with the app, so it also opens with no signal."),
    ("Disclaimer ", "shows the disclaimer again."),
    ("Wx Router version ", "shows which version is running. The same version is printed under every route."),
])

# ── 4 ────────────────────────────────────────────────────────────────────────
h1("4.  Planning a route")
screens([("route-setup", "Start and destination set"), ("waypoints", "Adding your own waypoints")], width=2.4)
steps([
    ("Set the start. ", "Tap “My location” to use the phone’s GPS position, or tap “Pick on chart” and then tap "
     "the chart where you will leave from. The position appears beside Start, and a green S on the chart."),
    ("Set the destination. ", "Tap “Pick on chart” on the Destination line and tap the chart. A red D appears. "
     "Put both inside the harbour or marina you are using: the planner allows for harbours with no sea forecast."),
    ("Waypoints (optional). ", "Leave “Add waypoints along the way?” on No to let the planner choose the way. "
     "Tap Yes to make the route pass through places of your choosing, in order: tap the chart once for each "
     "one, then tap Done. Each is numbered on the chart and listed with a Remove button; drag a marker to move "
     "it."),
    ("Set the departure. ", "It starts at the top of the next hour. Tap it to change the date and time. It must "
     "be within the forecast (about the next week)."),
    ("Tap Plan route. ", "A line under the buttons says what the planner is doing. A typical coastal passage "
     "takes from 30 seconds to two or three minutes, longer for a long passage or one that has to go around "
     "shallow banks."),
])
para("You can drag the S and D markers to move them at any time. Moving any point clears the old route; tap "
     "Plan route again.")
h2("What the planner does")
para("You don’t need to know this to use the app, but it explains the answers it gives.")
steps([
    ("Departure first. ", "Conditions at the start, at the departure time, must be within your limits for the "
     "course the boat sets off on, and outside your no-cruise hours. If they aren’t, no route is planned; the "
     "app tells you what is over the limits and the first time they won’t be (section 7)."),
    ("Then the quickest route within your limits. ", "The planner lays out possible waypoints either side of "
     "the direct line, downloads an hourly forecast for each, and finds the quickest path on which the seas and "
     "wind never exceed the limit for the direction they hit the boat from, at the time the boat is on each "
     "leg. The time on each leg allows for the forecast ocean current. Among equally quick routes it takes the "
     "calmest. Conditions at the destination on arrival must be within your limits too."),
    ("Otherwise the nearest port. ", "If the destination can’t be reached within your limits, the route goes to "
     "the port nearest the destination that can be (within 120 nm of it), and says why."),
])
para("Every leg is also checked against water depth (NOAA depths, with high-resolution coastal data within 3 nm "
     "of shore), a coastline built into the app so a route never crosses land, and OpenStreetMap’s coastline and "
     "bridges against your air draft. Where shallow banks block the straight way, the route is laid out around "
     "them through deep water.")
note("No line is ever drawn for a route that goes over your limits. If you see a route, every leg was within "
     "them in the forecast used.", lead="Good to know: ")

# ── 5 ────────────────────────────────────────────────────────────────────────
h1("5.  Reading the route")
screens([("route", "The route on the chart, and the route card")], width=2.6)
para("The route is drawn on the chart and described in a card below the buttons. At the top of the card:")
table(["Item", "Meaning"], [
    ["Distance", "Total length of the route in nautical miles."],
    ["Time underway", "Time moving, allowing for the current. Overnight stops are not counted."],
    ["Overnight stops", "Only shown when cruising hours make the route stop overnight."],
    ["Arrive", "Arrival date and time at the destination."],
    ["Worst vs. limit", "The worst seas or wind anywhere on the route, as a percentage of your limit for the "
                        "direction it comes from. 67% means the roughest moment uses two-thirds of your limit."],
    ["Shallowest water", "The shallowest depth found along the route."],
], [1.6, 4.9])
para("A short note under the figures explains the shape of the route: for example that the direct line is "
     "within your limits, that the route goes around shallow water or rough seas on the direct line, or that it "
     "is a little longer but quicker because it makes better use of the current.")
h2("Colours")
para("Each leg on the chart is coloured by its worst seas or wind against your limits:")
table(["Colour", "Worst seas or wind on the leg"], [
    ["Green", "under 70% of your limit"],
    ["Amber", "70% to 90% of your limit: within it, but getting close"],
    ["Red", "over 90% of your limit: within it, but only just"],
], [1.4, 5.1])
screens([("legs", "The legs table (a route with two waypoints)")], width=2.6)
h2("The legs table")
para("One row for each leg, from the start to the arrival:")
bullets([
    ("Waypoint: ", "Start, your own waypoints (“Your waypoint 1”), course changes the planner added (WP1, "
     "WP2…), and their positions."),
    ("Depart: ", "when the boat leaves that point."),
    ("Course: ", "the true course to steer (a rhumb line, so a constant course), the leg length, the speed over "
     "ground when the current makes a difference, and the shallowest depth on the leg (“near shore” where the "
     "coastal depth data was used)."),
    ("Worst seas / wind: ", "the worst wave height and period on the leg, where the seas hit the boat from, and "
     "your limit for that direction; then the worst wind, the same way. “Sheltered water (no sea forecast)” "
     "means a harbour or river where only the wind limits apply."),
])
para("A row reading “Overnight stop at …” shows where and when the boat stops for your no-cruise hours.")
h2("Notes under the table")
para("They say which depth data was used, that every leg was checked against the coastline and bridges, and "
     "which forecast was used. Read any note in red: it means something could not be checked, for example "
     "“Bridges couldn’t be checked” when OpenStreetMap does not answer, or “Water depth was not checked”. The "
     "route is still within your weather limits, but check that item on a chart yourself.")

# ── 6 ────────────────────────────────────────────────────────────────────────
h1("6.  When can you go?")
screens([("windows", "Departure timeline and windows")], width=2.6)
para("Every plan also checks each hour you could leave, across the whole forecast, for the whole passage. The "
     "card at the top of the results shows them as a timeline, with the days marked along it:")
table(["Colour", "Leaving at that hour…"], [
    ["Green", "keeps the whole passage within your limits"],
    ["Red", "goes over your limits somewhere on the way"],
    ["Grey", "would arrive after the end of the forecast, so it can’t be judged yet"],
    ["Purple", "is ruled out only by your no-cruise hours (shown when cruising hours are on)"],
], [1.4, 5.1])
bullets([
    ("Tap a green hour ", "to plan a route leaving then."),
    ("Departure windows ", "lists the spells of green hours as times."),
    ("Best departure ", "is the workable departure with the least time underway (then the calmest), with its "
     "arrival time and how close it comes to your limits. Tap “Use best departure” to plan it."),
])
para("A line on the timeline marks the departure you asked for.")

# ── 7 ────────────────────────────────────────────────────────────────────────
h1("7.  When there is no route")
screens([("gate", "Not yet: wait to leave")], width=2.6)
h2("Not yet: wait to leave")
para("If conditions at your departure point are over your limits at the departure time, or the time is in your "
     "no-cruise hours, no route is planned. The card lists what is over the limit at the start and by how much, "
     "and gives the first time it will be within your limits. Tap “Plan for that departure” to plan it.")
h2("No route within your limits")
para("If the passage can’t be made within your limits for this departure, the card says why: every possible "
     "path runs into seas, wind, steep seas or headings too close to the wind; no deep-enough water joins the two "
     "points; the passage can’t be finished before your no-cruise hours; or it runs past the end of the "
     "forecast. Then the app works out the path that goes over your limits the least, and lists each limit it "
     "would break, by how much, where and when, for example:")
para("Seas on the port bow: 6.2 ft against your 4.5 ft limit, 1.7 ft over near 25°51.00'N 79°38.00'W, "
     "Sat, Nov 21, 2:00 PM.", italic=True, color=GREY)
para("No line is drawn for that path. If a later departure works, the card gives the earliest one with a "
     "“Plan for that departure” button.")
h2("Route to the nearest port")
para("When the weather keeps you from the destination but a nearby port can be reached within your limits, the "
     "route goes there instead, and the card is headed “Route to” that port. A box explains that your destination "
     "can’t be reached, what stands in the way, how far the port is from it, and the earliest departure that "
     "would reach the destination itself.")

# ── 8 ────────────────────────────────────────────────────────────────────────
h1("8.  Safe havens and anchorages")
screens([("havens", "Safe havens near the route")], width=2.6)
para("After each plan, Wx Router lists harbours, marinas and anchorages within 15 nm of the route, from "
     "OpenSeaMap chart data, and marks them on the chart (H for a harbour, an anchor for an anchorage). Each "
     "shows how far it is off the route and how far along it.")
bullets([
    ("Safe haven ports ", "are charted harbours and marinas."),
    ("Anchorages ", "are judged for a 12-hour stay from when you would get there. The app looks at the open water "
     "around each one in 16 directions and the forecast wind. An anchorage with open water upwind and the shore "
     "close downwind in 10 kt or more is a lee shore and is left out (tap “anchorages left out” to see them and "
     "why). The rest get High, Medium or Low confidence from how sheltered they stay, how far ahead the forecast "
     "is, and the depth data."),
    ("Add as waypoint ", "puts that haven into your route where it adds the least distance. Tap Plan route to "
     "plan through it."),
])
note("Harbour and anchorage data comes from volunteers and can be incomplete. Always confirm on a chart, in a "
     "cruising guide and with local knowledge.", lead="Note: ")

# ── 9 ────────────────────────────────────────────────────────────────────────
h1("9.  Saved routes")
screens([("saved", "A saved route")], width=2.6)
para("If you make the same passage often, or are waiting for a weather window, save it:")
steps([
    ("Set up the route ", "(start, waypoints, destination) and tap “Save this route”."),
    ("Type a name ", "and tap OK. The route appears under “Saved routes” (tap to open the list)."),
    ("Tap “Check now” ", "on a saved route to load it and plan it from the next hour against the latest "
     "forecast."),
])
para("Each check is remembered (the last 10). The list shows the latest check’s best departure, how close it "
     "comes to your limits and how many departure hours work, and whether that is better, worse or about the "
     "same as the check before, so you can watch a window opening or closing. Delete removes a saved route.")

# ── 10 ───────────────────────────────────────────────────────────────────────
h1("10.  Exporting, printing, clearing and closing")
h2("Export GPX")
para("“Export GPX” (under Plan route, and at the bottom of the route card) saves the route as a GPX file named "
     "wx-route.gpx, with every waypoint named as in the legs table. Open or share it with your chartplotter app "
     "or navigation software. On an iPhone it goes to Downloads in the Files app. When there is no route within "
     "your limits but a later departure works, the button exports that route instead and says so.")
h2("Print settings and route")
para("Prints (or saves as a PDF, from the phone’s print screen) your vessel settings and all your limits, the "
     "start, waypoints and destination, a sketch of the route, the departure windows and the legs table. Plan "
     "the route first to include it. Handy for a float plan or the nav station.")
h2("Clear")
para("The Clear button at the top right of the chart removes the start, destination, waypoints and route.")
h2("Closing the app")
para("Tap ✕ at the top right. Phones don’t let a web app close itself, so a “Wx Router is closed” screen "
     "appears; close the app the usual way (swipe up on an iPhone, Back on Android), or tap “Return to Wx "
     "Router”. Your settings and saved routes stay on the phone.")

# ── 11 ───────────────────────────────────────────────────────────────────────
h1("11.  A worked example")
para("Sea Breeze is a 34 ft motor boat cruising at 18 kt, with a 3.5 ft draft and a 14 ft air draft. The "
     "crew want to run from Port Everglades to Bimini, about 49 nm across the Gulf Stream. The pictures in this "
     "manual come from this example, planned on " + EXAMPLE_DATE + ".")
steps([
    ("Settings. ", "Vessel name Sea Breeze, Motor, length 34, freeboard 4, draft 3.5, air draft 14, minimum "
     "depth 7 ft, keep off land 0.5 nm, cruise speed 18 kt. Leave the default sea and wind limits. Tap Save "
     "settings."),
    ("Route. ", "Pick on chart for the start and tap inside Port Everglades; Pick on chart for the destination "
     "and tap the harbour at Alice Town, North Bimini. Leave waypoints on No."),
    ("Departure. ", "Leave it at the next hour, and tap Plan route."),
    ("Read the answer. ", EXAMPLE_RESULT),
    ("Choose the day. ", "Look at “When can you go?”. In a northerly wind the Gulf Stream stands up into steep "
     "seas and the timeline turns red; the green hours show when the crossing works. Tap the best departure, or "
     "a green hour that suits you."),
    ("Check and export. ", "Look over the havens near the route, check the route on a chart, then Export GPX to "
     "your plotter and Print the plan for the nav station. Tap Save this route, and use Check now each day to "
     "watch the forecast."),
])

# ── 12 ───────────────────────────────────────────────────────────────────────
h1("12.  Troubleshooting")
table(["What you see", "What to do"], [
    ["“Please set a start point, set a destination…”",
     "Something needed is missing: set the points, or fill in the cruise speed, all eight sea and wind limits and "
     "the minimum depth in Settings."],
    ["“The forecast runs from … to …”",
     "The departure is outside the forecast (about the next week). Choose a time inside that window."],
    ["“Could not get the forecast”",
     "Check the internet connection and try again. If it mentions a request limit, the free service is busy or "
     "the day’s allowance is used: wait a minute (or until tomorrow) and try again."],
    ["The progress line says it is waiting",
     "Long routes are paced to stay inside the free forecast service’s limits. Let it finish."],
    ["“No route within your limits”",
     "Read the list of limits in the way, and look at the timeline for a green hour. Consider waypoints that "
     "keep you in the lee of land, or, only if it is safe, loosen a limit in Settings."],
    ["No route, and the start or destination is up a river or creek",
     "The planner can’t always follow a narrow, winding channel. Set that end at the river mouth or inlet."],
    ["“Close to land: the only way through passes …”",
     "The only way goes closer to land than Keep off land allows, such as a cut between cays. If you know the "
     "passage, lower Keep off land in Settings."],
    ["“Bridges couldn’t be checked” or “Water depth was not checked”",
     "An online data service did not answer. The route is still within your weather limits; check bridges or "
     "depths on the chart yourself, or plan again later."],
    ["“My location” does nothing or gives an error",
     "Allow Location for Wx Router (iPhone: Settings › Privacy & Security › Location Services › Safari Websites; "
     "Android: Settings › Apps › Chrome › Permissions › Location), or pick the start on the chart."],
    ["Saved routes or settings are missing",
     "On an iPhone, the Home Screen icon and Safari keep separate data. Open the app the same way you did when "
     "you saved them."],
], [2.4, 4.1])

# ── 13 ───────────────────────────────────────────────────────────────────────
h1("13.  Your data, updates and removing the app")
bullets([
    ("Your data stays on your phone. ", "Settings, saved routes and any API key are stored only on the phone. "
     "To plan, the app sends the positions it needs forecasts, depths and chart data for to those services "
     "(Open-Meteo, NOAA, OpenStreetMap); nothing else about you is sent."),
    ("Removing the app deletes its settings and saved routes. ", "So does clearing the browser’s website data. "
     "Print or write down anything you want to keep."),
    ("Updates: ", "there is nothing to download. When you open the app with an internet connection it picks up "
     "any new version by itself; close it and open it again to start using it. The version number is shown in "
     "Settings and under every route."),
    ("To remove it, iPhone: ", "press and hold the Wx Router icon, tap “Remove App”, then “Delete App”."),
    ("To remove it, Android: ", "press and hold the icon, then tap “Uninstall”."),
])

# ── 14 ───────────────────────────────────────────────────────────────────────
h1("14.  What the app is based on, and its limits")
bullets([
    ("Forecast: ", "Open-Meteo’s marine forecast (wave height, direction and period, and ocean currents from the "
     "MeteoFrance SMOC model) and its weather forecast for the wind, about 7 days ahead."),
    ("Water depth: ", "NOAA NCEI bathymetry (the DEM Global Mosaic), and within 3 nm of shore NOAA’s "
     "high-resolution coastal models (1/9 arc-second, about 3 m)."),
    ("Coastline: ", "GSHHG full resolution (Wessel and Smith), built into the app, plus OpenStreetMap’s "
     "coastline and bridges."),
    ("Harbours and anchorages: ", "OpenSeaMap and OpenStreetMap, plus a built-in list of commercial ports."),
    ("Chart: ", "OpenStreetMap with OpenSeaMap chart symbols. It is not a navigation chart."),
])
para("Limits to keep in mind:")
bullets([
    "The forecast is a model. Real seas and wind can be well above it, especially near squalls, in inlets and "
    "where the current runs against the wind.",
    "Seas are the combined significant wave height and mean direction; swell and wind waves are not checked "
    "separately. Some waves will be much bigger than the significant height.",
    "Depths are referenced to about high water, not chart datum, and are sampled at points, so small shoals, "
    "reefs and wrecks can be missed. Always check the route on an official chart.",
    "Bridges are only as good as OpenStreetMap’s data, and are only checked when that service answers.",
    "The current comes from an ocean model and does not replace tidal-stream data close inshore.",
    "The route is the quickest on the planner’s grid of possible waypoints, so it can be slightly longer than a "
    "perfectly drawn line, and narrow channels can be missed.",
    "Length and freeboard don’t change the routing yet.",
])
para("The full disclaimer is shown the first time the app is opened and can be read again from Settings.")

doc.core_properties.title = "Wx Router – User’s Manual"
doc.core_properties.author = ""
doc.save(OUT)
print("wrote", OUT)

if os.path.exists(SOFFICE):
    for fmt in ("doc:MS Word 97", "pdf"):
        subprocess.run([SOFFICE, "--headless", "--convert-to", fmt, "--outdir", ROOT, OUT],
                       check=True, capture_output=True, timeout=180)
        print("wrote", os.path.splitext(OUT)[0] + "." + fmt.split(":")[0])
