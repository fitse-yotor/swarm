"""Build the two research case PDFs for testing M2 Swarm.

    backend/.venv/bin/python cases/build_case_pdfs.py

Timelines are written as full sentences (not tables) so PDF text extraction and the
entity/relation extractor see clean "who did what, when" statements. Synthetic persona
lines use the same format as ETH_Sea_Access_Case_Study.md so the environment importer
can read them, with an explicit [stance ±x.x] on the axis stated in each case.
"""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

OUT = Path(__file__).resolve().parent
ss = getSampleStyleSheet()
H1 = ParagraphStyle("h1", parent=ss["Title"], fontSize=19, leading=23, alignment=TA_LEFT, spaceAfter=4)
H2 = ParagraphStyle("h2", parent=ss["Heading2"], fontSize=13, leading=16, spaceBefore=12, spaceAfter=5,
                    textColor=colors.HexColor("#1d3557"))
H3 = ParagraphStyle("h3", parent=ss["Heading3"], fontSize=10.5, leading=13, spaceBefore=6, spaceAfter=2)
BODY = ParagraphStyle("b", parent=ss["BodyText"], fontSize=9.6, leading=13.4, spaceAfter=4)
BUL = ParagraphStyle("bul", parent=BODY, leftIndent=12, bulletIndent=2, spaceAfter=3)
META = ParagraphStyle("m", parent=BODY, fontSize=8.8, textColor=colors.HexColor("#444444"))
NOTE = ParagraphStyle("n", parent=BODY, fontSize=9, backColor=colors.HexColor("#fff6dd"), borderColor=colors.HexColor("#e0b84a"),
                      borderWidth=0.6, borderPadding=6, spaceBefore=6, spaceAfter=10)
SRC = ParagraphStyle("s", parent=BODY, fontSize=8.4, leading=11, spaceAfter=2)


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(colors.HexColor("#777777"))
    canvas.drawString(18 * mm, 10 * mm, doc.case_id + " - research test case. Synthetic personas are fictional.")
    canvas.drawRightString(192 * mm, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


def build(case: dict) -> Path:
    path = OUT / case["file"]
    doc = SimpleDocTemplate(str(path), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm,
                            bottomMargin=18 * mm, title=case["title"], author="M2 Swarm research desk",
                            subject=case["question"][:200])
    doc.case_id = case["id"]
    s = [Paragraph(f"Case {case['id']} - {case['title']}", H1)]
    for k, v in case["meta"]:
        s.append(Paragraph(f"<b>{k}:</b> {v}", META))
    s.append(Paragraph(case["integrity"], NOTE))

    s.append(Paragraph("1. Case question", H2))
    s.append(Paragraph(case["question"], BODY))
    s.append(Paragraph("2. Analytical boundaries", H2))
    s += [Paragraph(b, BUL, bulletText="-") for b in case["boundaries"]]

    s.append(Paragraph("3. Documented timeline", H2))
    s.append(Paragraph("Each line is a sourced statement. Items marked <i>[verify]</i> are widely reported but were not "
                       "re-checked against a primary source for this file; confirm before approving them in the graph.", META))
    for date, text, src in case["timeline"]:
        ref = "<i>[verify]</i>" if src == "[verify]" else f"({src})"
        s.append(Paragraph(f"<b>{date}.</b> {text} <font color='#1d3557'>{ref}</font>", BUL, bulletText="-"))

    s.append(Paragraph("4. Actor perspectives (documented)", H2))
    for name, text in case["actors"]:
        s.append(KeepTogether([Paragraph(name, H3), Paragraph(text, BODY)]))

    if case.get("extra"):
        for title, paras in case["extra"]:
            s.append(Paragraph(title, H2))
            s += [Paragraph(p, BODY) for p in paras]

    s.append(Paragraph(f"{case['n_entities']}. Entity categories and relationships", H2))
    s.append(Paragraph(case["entities"], BODY))
    s.append(Paragraph(case["relations"], BODY))

    s.append(PageBreak())
    s.append(Paragraph(f"{case['n_entities'] + 1}. Synthetic persona archetypes (fictional - for simulation only)", H2))
    s.append(Paragraph(case["persona_note"], NOTE))
    s.append(Paragraph(case["topics"], META))
    for pid, label, where, view, stance, quote, topic in case["personas"]:
        s.append(Paragraph(f"<b>{pid} - {label} ({where}; {view})</b> [stance {stance:+.1f}]: “{quote}” "
                           f"[simulation topic {topic}]", BUL, bulletText="-"))

    s.append(Paragraph(f"{case['n_entities'] + 2}. Test scenarios (hypothetical)", H2))
    for i, (t, d) in enumerate(case["scenarios"], 1):
        s.append(Paragraph(f"<b>Scenario {i} - {t}.</b> {d}", BUL, bulletText="-"))

    s.append(Paragraph(f"{case['n_entities'] + 3}. Suggested M2 Swarm settings", H2))
    rows = [["Field", "Value"]] + [[k, Paragraph(v, SRC)] for k, v in case["settings"]]
    t = Table(rows, colWidths=[38 * mm, 136 * mm])
    t.setStyle(TableStyle([("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.5), ("FONT", (0, 1), (0, -1), "Helvetica", 8.5),
                           ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8eef6")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                           ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c9d3e0"))]))
    s.append(t)

    s.append(Paragraph(f"{case['n_entities'] + 4}. Sources", H2))
    for sid, text, url in case["sources"]:
        s.append(Paragraph(f"<b>{sid}.</b> {text} <font color='#1d4ed8'>{url}</font>", SRC))
    s.append(Spacer(1, 6))
    s.append(Paragraph("Completion criteria: every historical statement in the approved graph links to a source passage; no "
                       "synthetic persona is presented as a real person; real officials and institutions are context-only in "
                       "simulations; simulated results are never reported as public opinion or forecasts.", META))
    doc.build(s, onFirstPage=footer, onLaterPages=footer)
    return path


INTEGRITY = ("<b>Research integrity.</b> Named officials, parties and governments appear only through reported public "
             "positions at cited dates. All persona comments in the synthetic section are written for simulation: they are "
             "not quotations, not scraped posts, not real people, not polling data and not predictions. Contested figures are "
             "given as ranges with their sources. Where sources disagree, both are recorded.")

TIGRAY = {
    "file": "ETH-TIG-001_Tigray_War_and_Aftermath.pdf",
    "id": "ETH-TIG-001",
    "title": "The Tigray War (2020-2022) and the Post-Pretoria Period",
    "meta": [("Status", "research-backed seed case + fictional simulation inputs"), ("As of", "1 November 2026"),
             ("Geographic scope", "Ethiopia (Tigray, Amhara, Afar), Eritrea; African Union mediation"),
             ("Purpose", "case creation, evidence-aware graph extraction and multi-agent scenario exploration in M2 Swarm")],
    "integrity": INTEGRITY,
    "question": ("How did the war in Tigray unfold between November 2020 and November 2022, how did the federal government, "
                 "the Tigray People's Liberation Front (TPLF), Eritrea and international bodies present it, and how has the "
                 "implementation of the Pretoria agreement developed since? Under hypothetical scenarios, how might "
                 "government-aligned, government-critical and TPLF-aligned viewpoints (synthetic only) interact?"),
    "boundaries": [
        "Record violations as attributed in the cited investigations: the EHRC-OHCHR report found violations by all parties.",
        "Give casualty figures only as sourced ranges; the true toll is contested and may never be known.",
        "Do not resolve contested characterisations (for example, genocide allegations made by Tigrayan groups and some "
        "scholars, which the federal government rejects); record who makes each claim.",
        "Do not generalise from any ethnic group to individuals; no dehumanising language in any persona or post.",
        "The full text of the Pretoria agreement was not officially published; provisions are cited from secondary summaries.",
        "Synthetic personas represent viewpoints for testing only. They are never evidence of what real people think.",
        "Do not create statements in the names of real officials, parties or governments; real actors are context-only.",
    ],
    "timeline": [
        ("4 November 2020", "Fighting erupted between federal forces and the TPLF in Tigray after an attack on the Northern "
         "Command of the Ethiopian National Defense Force; the federal government launched military operations.", "S01 [verify]"),
        ("28 November 2020", "Federal forces entered Mekelle, the Tigray regional capital.", "[verify]"),
        ("23 March 2021", "Prime Minister Abiy Ahmed acknowledged the presence of Eritrean troops in Tigray after denying it "
         "for months.", "S02"),
        ("3 April 2021", "The Ethiopian Ministry of Foreign Affairs said Eritrean forces had started withdrawing from Tigray; "
         "residents disputed this.", "S03"),
        ("May 2021", "The Ethiopian parliament designated the TPLF a terrorist organisation.", "[verify]"),
        ("June 2021", "Federal forces withdrew from Mekelle and the government declared a unilateral ceasefire; Tigrayan "
         "forces later advanced into Amhara and Afar.", "[verify]"),
        ("Summer 2021", "According to the US State Department, Iran delivered Mohajer-6 armed drones to Ethiopia, which the "
         "Ethiopian military used in Tigray.", "S04"),
        ("3 November 2021", "The Ethiopian Human Rights Commission (EHRC) and the UN Office of the High Commissioner for "
         "Human Rights (OHCHR) published a joint investigation finding violations by the Ethiopian National Defense Force, "
         "the Eritrean Defense Forces, the Tigray Defense Forces, Amhara special forces and Fano militias.", "S05"),
        ("6 November 2021", "Canada, New Zealand, Australia and other governments issued a joint statement calling the "
         "findings grave and urging all parties to implement the report's recommendations.", "S06"),
        ("2 November 2022", "The Ethiopian federal government and the TPLF signed the Agreement for Lasting Peace through a "
         "Permanent Cessation of Hostilities in Pretoria under African Union mediation.", "S07, S08"),
        ("15 January 2023", "African Union mediator Olusegun Obasanjo said up to 600,000 people may have died in the war; "
         "Ethiopian officials cited lower figures of 80,000 to 100,000, and researchers published ranges between these.", "S09, S10"),
        ("March 2023", "Getachew Reda became president of the Tigray Interim Regional Administration.", "S11"),
        ("13 February 2025", "The National Election Board of Ethiopia (NEBE) suspended the TPLF from political activity for "
         "three months for failing to hold a general assembly.", "S12"),
        ("March-April 2025", "Getachew Reda was removed amid a split within the TPLF; Prime Minister Abiy appointed Tadesse "
         "Werede to lead the Tigray Interim Administration.", "S11, S13"),
        ("May 2025", "NEBE deregistered the TPLF as a political party; the TPLF rejected the decision, arguing that the "
         "Pretoria agreement restored its legal status.", "S14"),
        ("September 2025", "Interim president Tadesse Werede called the revocation of the TPLF's legal status unacceptable and "
         "urged a political settlement; the TPLF accused the guarantors of the Pretoria agreement of inaction.", "S13, S15"),
        ("October 2025", "Prime Minister Abiy accused the TPLF of breaching the peace agreement and said the group could "
         "restore its legality by re-registering with NEBE.", "S16"),
        ("February 2026", "Reporting described growing fears of armed confrontation between Ethiopia and Eritrea over "
         "Tigray and the border.", "S17"),
    ],
    "actors": [
        ("Federal Government of Ethiopia / Prime Minister Abiy Ahmed", "Presented the 2020 operations as a response to the "
         "attack on the Northern Command; signed the Pretoria agreement in 2022; in 2025 said the TPLF may regain legal "
         "status by re-registering. Sources S02, S07, S16."),
        ("Tigray People's Liberation Front (TPLF)", "Party to the Pretoria agreement; disputes its deregistration and argues "
         "Pretoria restored its pre-war status; accuses guarantors of inaction. Internally split since 2025. Sources S14, S15."),
        ("Tigray Interim Regional Administration", "Led by Getachew Reda (2023-2025) and then Tadesse Werede; Tadesse called "
         "for a political settlement of the TPLF's status. Sources S11, S13."),
        ("Eritrea / Eritrean Defense Forces", "Took part in the war alongside federal forces (acknowledged March 2021); not a "
         "signatory to Pretoria; relations with Addis Ababa deteriorated afterwards. Sources S02, S05, S17."),
        ("African Union mediation panel", "Mediated Pretoria; mediator Olusegun Obasanjo gave the highest public death-toll "
         "estimate. Sources S07, S09."),
        ("EHRC and OHCHR", "Joint investigation covering 3 November 2020 to 28 June 2021; criticised by some Tigrayan and "
         "advocacy groups because the EHRC is a state body. Source S05."),
    ],
    "n_entities": 5,
    "entities": ("<b>Entity categories:</b> Person, Organization (parties, armed forces, commissions, media), Country, "
                 "Location (Tigray, Mekelle, Western Tigray, Amhara, Afar), Event, Policy (Pretoria agreement, terrorist "
                 "designation, NEBE decisions), Topic (humanitarian access, displacement, accountability, disarmament)."),
    "relations": ("<b>Relationship examples:</b> PERSON -ANNOUNCED-> POLICY; ORGANIZATION -PARTICIPATED_IN-> EVENT; "
                  "ORGANIZATION -OPPOSES-> POLICY; ORGANIZATION -REPORTS_ON-> EVENT. Every factual edge needs a cited "
                  "passage. Do not infer coordination or alliance from two names appearing in the same sentence."),
    "persona_note": ("All personas below are fictional archetypes written for M2 Swarm testing. They are not real people and "
                     "their lines are not real posts. Import them into an environment as synthetic agents; keep real "
                     "actors context-only. Stance axis for this case: -1.0 = strongly critical of the federal government's "
                     "handling of the war and peace process, +1.0 = strongly supportive."),
    "topics": "Topic codes: T01 peace and security; T02 political settlement and legal status; T03 humanitarian recovery "
              "and displacement; T04 accountability and information integrity.",
    "personas": [
        ("SIM01", "Addis Ababa civil servant", "Ethiopia", "government-aligned", 0.7,
         "The Pretoria agreement ended the fighting. The priority now is disarmament and rebuilding under the constitution.", "T01"),
        ("SIM02", "Small-business owner in Bahir Dar", "Ethiopia", "government-aligned", 0.5,
         "My customers want roads open and prices stable. Peace has to be protected before anything else.", "T03"),
        ("SIM03", "Retired teacher in Adama", "Ethiopia", "cautiously supportive", 0.35,
         "I support the peace deal, but people need to see accountability, not only speeches.", "T04"),
        ("SIM04", "Diaspora engineer in Washington DC", "Ethiopian diaspora", "government-aligned", 0.6,
         "Investment will follow stability. Every side should commit to the agreement in practice.", "T01"),
        ("SIM05", "University lecturer in Addis Ababa", "Ethiopia", "government-critical", -0.5,
         "Ending one war did not end the political crisis. Conflicts elsewhere in the country show that.", "T02"),
        ("SIM06", "Opposition party volunteer", "Ethiopia", "government-critical", -0.6,
         "Peace needs an inclusive political dialogue, not decisions made by a few people at the top.", "T02"),
        ("SIM07", "Freelance journalist", "Ethiopia", "verification-focused", -0.2,
         "Every casualty figure in this war is disputed. I want independent access before anyone claims certainty.", "T04"),
        ("SIM08", "Health worker in Mekelle", "Tigray, Ethiopia", "TPLF-aligned", -0.7,
         "Clinics are still short of medicine. Until services fully return, people here will not feel the war is over.", "T03"),
        ("SIM09", "Displaced farmer from Western Tigray", "Tigray, Ethiopia", "TPLF-aligned", -0.8,
         "The agreement promised that displaced people could go home. Many of us are still waiting in camps.", "T03"),
        ("SIM10", "Tigrayan student in Addis Ababa", "Ethiopia", "TPLF-sympathetic", -0.5,
         "I want peace and a future here. The dispute over the TPLF's legal status should be solved by talks.", "T02"),
        ("SIM11", "Tigrayan diaspora activist", "Ethiopian diaspora", "TPLF-aligned", -0.8,
         "Accountability for abuses documented by investigators must be part of any lasting peace.", "T04"),
        ("SIM12", "Afar pastoralist leader", "Afar, Ethiopia", "neutral", 0.0,
         "Our communities were also hit by the war. Recovery funds should reach every affected region.", "T03"),
        ("SIM13", "Humanitarian logistics officer", "Regional", "neutral", 0.0,
         "Access for aid convoys is the measure that matters to families, whatever the politics.", "T03"),
        ("SIM14", "Horn of Africa analyst", "Regional", "analytical", 0.0,
         "The key risk now is the triangle between Addis Ababa, Mekelle and Asmara, not the 2020 front lines.", "T01"),
        ("SIM15", "Peace-building NGO worker", "Ethiopia", "peace-focused", 0.1,
         "Disarmament, return of the displaced and transitional justice must move together or none will hold.", "T01"),
    ],
    "scenarios": [
        ("Pretoria implementation advances", "Disarmament and return of displaced people progress on schedule; explore how "
         "each viewpoint reacts to visible delivery versus announcements."),
        ("Political deadlock over legal status", "Talks on the TPLF's registration stall; compare how government-aligned, "
         "government-critical and TPLF-aligned personas frame the impasse."),
        ("Border escalation risk", "Reports of troop movements near the Eritrean border circulate; test how calls for "
         "restraint and verification spread compared with alarm."),
        ("Information disorder", "An unverified casualty claim spreads; test source checking and correction behaviour "
         "without attributing invented quotes to real actors."),
    ],
    "settings": [
        ("Case title", "The Tigray War (2020-2022) and the Post-Pretoria Period (ETH-TIG-001)"),
        ("Research question", "Section 1 of this document."),
        ("Primary scope", "Country"),
        ("Tags", "ethiopia, tigray, tplf, pretoria agreement, eritrea, african union, humanitarian"),
        ("Entity types", "All seven"),
        ("Environment", "Focus issue: Pretoria agreement; real actors context-only; import section 6 personas"),
        ("Simulation", "24 rounds; 1-2 LLM-written posts per round on a CPU-only machine"),
    ],
    "sources": [
        ("S01", "Al Jazeera, 23 May 2023 - Protesters in Tigray demand Eritrean troops withdraw (background on November 2020).",
         "https://www.aljazeera.com/amp/news/2023/5/23/protesters-in-ethiopias-tigray-demand-eritrean-troops-withdraw"),
        ("S02", "Christian Science Monitor / Reuters, 26 March 2021 - Eritrea withdrawing troops from Tigray, Abiy says.",
         "https://csmonitor.com/World/Africa/2021/0326/Eritrea-withdrawing-troops-from-Tigray-Ethiopia-s-Abiy-says"),
        ("S03", "Al Jazeera, 4 April 2021 - Ethiopia says Eritrean troops started withdrawing from Tigray.",
         "https://www.aljazeera.com/news/2021/4/4/ethiopia-says-eritrean-troops-started-withdrawing-from-tigray"),
        ("S04", "Nation (Kenya) - US: Iran gave Ethiopia armed drones in Tigray war.",
         "https://nation.africa/africa/news/us-iran-gave-ethiopia-armed-drones-in-tigray-war-3991858"),
        ("S05", "EHRC - EHRC-OHCHR joint investigation report on the Tigray conflict, 3 November 2021.",
         "https://ehrc.org/download/ehrc-ohchr-joint-investigation-report-on-tigray-conflict/"),
        ("S06", "Global Affairs Canada - Joint statement on release of OHCHR-EHRC joint investigation, 6 November 2021.",
         "https://www.canada.ca/en/global-affairs/news/2021/11/joint-statement-on-release-of-ohchr-ehrc-joint-investigation-november-6-2021.html"),
        ("S07", "The EastAfrican, 2 November 2022 - Ethiopia, Tigray sign deal in Pretoria for cessation of hostilities.",
         "https://www.theeastafrican.co.ke/tea/rest-of-africa/ethiopia-tigray-sign-deal-to-cease-hostilities-4006688"),
        ("S08", "Daily Maverick, 2 November 2022 - Warring Ethiopian parties sign peace agreement in Pretoria.",
         "https://www.dailymaverick.co.za/article/2022-11-02-warring-ethiopian-parties-silence-the-guns-by-signing-historic-peace-agreement-in-pretoria.md"),
        ("S09", "Eye Radio, January 2023 - War in Tigray killed 600,000, AU mediator says.",
         "https://www.eyeradio.org/war-in-tigray-killed-600000-au-mediator/"),
        ("S10", "Wikipedia - Casualties of the Tigray war (overview of competing estimates; use only to locate primary studies).",
         "https://en.wikipedia.org/wiki/Casualties_of_the_Tigray_war"),
        ("S11", "Lawfare - Ethiopia's troubled peace (Tigray Interim Administration leadership changes).",
         "https://www.lawfaremedia.org/article/ethiopia-s-troubled-peace"),
        ("S12", "The Reporter Ethiopia - Election Board proscribes TPLF ahead of party's 50th anniversary.",
         "https://www.thereporterethiopia.com/43834/"),
        ("S13", "AllAfrica, September 2025 - Tigray interim president calls revocation of TPLF's legal status unacceptable.",
         "https://allafrica.com/stories/202509150068.html"),
        ("S14", "Eastleigh Voice, May 2025 - Ethiopia's electoral board deregisters the TPLF.",
         "https://eastleighvoice.co.ke/ethiopia%20tigray%20war/150281/ethiopia-s-electoral-board-deregisters-tigray-people-s-liberation-front-casting-uncertainty-over-peace-process"),
        ("S15", "AllAfrica, September 2025 - TPLF accuses guarantors of Pretoria agreement of inaction.",
         "https://allafrica.com/stories/202509300370.html"),
        ("S16", "AllAfrica, October 2025 - PM Abiy accuses TPLF of breaching peace deal.",
         "https://allafrica.com/stories/202510290001.html"),
        ("S17", "Africanews, 9 February 2026 - Ethiopia-Eritrea tensions: fears of armed confrontation grow.",
         "https://www.africanews.com/2026/02/09/ethiopia-eritrea-tensions-fears-of-armed-confontation-grow/"),
    ],
}

MILITARY = {
    "file": "ETH-SEC-002_Ethiopia_Military_Capability_and_Regional_Alignments.pdf",
    "id": "ETH-SEC-002",
    "title": "Ethiopia's Military Capability and Regional Alignments in the Horn of Africa",
    "meta": [("Status", "open-source research case + fictional simulation inputs"), ("As of", "1 November 2026"),
             ("Geographic scope", "Ethiopia, Eritrea, Somalia, Somaliland (disputed status), Djibouti, Egypt, Türkiye, "
              "Saudi Arabia, United Arab Emirates, Israel"),
             ("Purpose", "graph extraction of documented alignments and scenario exploration in M2 Swarm")],
    "integrity": INTEGRITY + (" Capability information is limited to publicly reported acquisitions and agreements; it contains "
                              "no operational, deployment or targeting detail, and unconfirmed reports are flagged as such."),
    "question": ("What military capabilities has Ethiopia publicly acquired or developed since 2018, and how have its "
                 "relationships with Eritrea, Somalia, Egypt, Türkiye, Saudi Arabia, the United Arab Emirates and Israel "
                 "shifted, particularly around the Red Sea, the Grand Ethiopian Renaissance Dam (GERD) and Somaliland? "
                 "Which documented alignments support or constrain Ethiopia's stated goals?"),
    "boundaries": [
        "Use only open-source reporting; flag single-source or unconfirmed claims (for example, UAE drone supply).",
        "Published force-size estimates differ widely and are omitted; do not invent numbers.",
        "A defence agreement, a summit or a diplomatic statement is not an alliance; record what was actually signed or said.",
        "Do not infer coordination between two states because they appear in the same article.",
        "Treat Somaliland's status as disputed; Israel's recognition is recorded with the regional reactions to it.",
        "Synthetic personas are fictional; real governments and officials are context-only in simulations.",
    ],
    "timeline": [
        ("16 September 2018", "Prime Minister Abiy Ahmed and President Isaias Afwerki signed a peace agreement in Jeddah, "
         "hosted by Saudi Arabia, with the United Arab Emirates acting as a facilitator.", "S01, S02"),
        ("12 March 2019", "Ethiopia and France signed a defence cooperation agreement that included support for a future "
         "Ethiopian navy; later reporting said no vessels had been exported under it.", "S03"),
        ("2021", "Satellite imagery analysed by PAX showed Turkish Bayraktar TB2, Chinese Wing Loong and Iranian Mohajer-6 "
         "drones at Ethiopian air bases; supply of Wing Loong drones by the UAE was described as likely but not confirmed.", "S04, S05"),
        ("Summer 2021", "According to the US State Department, Iran delivered Mohajer-6 armed drones to Ethiopia.", "S06"),
        ("2024", "Reporting said the Ethiopian Air Force received Russian Su-30 fighter aircraft and Turkish Akinci drones; "
         "the exact delivery date should be confirmed.", "S07 [verify]"),
        ("1 January 2024", "Ethiopia and Somaliland signed a memorandum of understanding on sea access; Somalia rejected it on "
         "sovereignty grounds.", "S08"),
        ("8 February 2024", "Somalia and Türkiye signed a defence and economic cooperation agreement under which Türkiye would "
         "help build, train and equip the Somali navy; the full text was not published.", "S09"),
        ("August 2024", "Egypt and Somalia signed a defence pact and military cooperation protocol in Cairo.", "S10"),
        ("10 October 2024", "The presidents of Egypt, Eritrea and Somalia met in Asmara and pledged to strengthen security "
         "cooperation and support Somalia's territorial integrity.", "S10, S11"),
        ("11 December 2024", "Ethiopia and Somalia agreed the Ankara Declaration, facilitated by Türkiye, on a commercial "
         "access pathway under Somali sovereignty.", "S12"),
        ("March-May 2025", "Ethiopia's foreign minister visited Israel in March 2025, and Israeli Foreign Minister Gideon Sa'ar "
         "met Prime Minister Abiy in Addis Ababa in May 2025.", "S13"),
        ("9 September 2025", "Ethiopia inaugurated the Grand Ethiopian Renaissance Dam; Egypt protested to the UN Security "
         "Council and called the dam a unilateral step.", "S14"),
        ("26 December 2025", "Israel recognised Somaliland as an independent state; Somalia, Egypt, Türkiye and Djibouti "
         "condemned the decision, the African Union reaffirmed Somalia's unity and Saudi Arabia affirmed Somalia's "
         "territorial integrity.", "S15, S16"),
        ("24-25 February 2026", "Israeli President Isaac Herzog made a state visit to Addis Ababa.", "S17"),
        ("February 2026", "Reporting described rising Ethiopia-Eritrea tensions and fears of armed confrontation.", "S18"),
    ],
    "actors": [
        ("Ethiopia (ENDF, Ethiopian Air Force)", "Expanded drone and air capabilities since 2021 from several suppliers; "
         "seeks a navy and sea access; states a preference for peaceful negotiation. Sources S03-S07."),
        ("Eritrea", "Signed peace with Ethiopia in 2018 and fought alongside federal forces in Tigray; joined the 2024 Asmara "
         "summit with Egypt and Somalia; relations with Addis Ababa deteriorated by 2025-2026. Sources S01, S11, S18."),
        ("Somalia", "Rejected the 2024 Somaliland memorandum; signed defence agreements with Türkiye and Egypt; agreed the "
         "Ankara Declaration with Ethiopia. Sources S08-S12."),
        ("Egypt", "Opposes the GERD's unilateral operation; signed a defence pact with Somalia; condemned Israel's "
         "recognition of Somaliland. Sources S10, S14, S15."),
        ("Türkiye", "Reported supplier of TB2 and Akinci drones to Ethiopia; defence partner of Somalia; facilitated the "
         "Ankara Declaration; condemned recognition of Somaliland. Sources S04, S07, S09, S12, S15."),
        ("Saudi Arabia", "Hosted the 2018 Jeddah peace signing; affirmed Somalia's territorial integrity in December 2025. "
         "Sources S01, S16."),
        ("United Arab Emirates", "Facilitated the 2018 rapprochement and announced investment plans; reported but unconfirmed "
         "drone supply to Ethiopia. Sources S02, S04."),
        ("Israel", "Long-standing ties with Ethiopia, high-level visits in 2025-2026; first state to recognise Somaliland. "
         "Sources S13, S15, S17."),
    ],
    "extra": [("5. Alignment summary (documented, not alliances)", [
        "Ethiopia has diversified arms suppliers (Türkiye, China, Iran and Russia are reported) rather than relying on one partner.",
        "A grouping of Egypt, Eritrea and Somalia formed around security cooperation in 2024; analysts linked it to tensions with "
        "Ethiopia, while sources differ on how binding it is.",
        "Türkiye holds ties with both Ethiopia and Somalia and acted as mediator through the Ankara Declaration.",
        "Gulf states have acted as hosts, facilitators and investors; their positions on Somaliland and the Red Sea differ by case.",
    ])],
    "n_entities": 6,
    "entities": ("<b>Entity categories:</b> Country, Organization (armed forces, ministries, African Union), Person (heads of "
                 "state and ministers at cited dates), Location (ports, bases, the Red Sea), Event (summits, signings, "
                 "inaugurations), Policy (agreements, memoranda, declarations), Topic (sea access, GERD, drones, Somaliland)."),
    "relations": ("<b>Relationship examples:</b> COUNTRY -NEGOTIATES_WITH-> COUNTRY; COUNTRY -SUPPORTS-> POLICY; COUNTRY "
                  "-OPPOSES-> POLICY; COUNTRY -HOSTS-> EVENT; ORGANIZATION -PARTICIPATED_IN-> EVENT. Arms transfers are "
                  "recorded as reported events with their source and confidence, never as confirmed facts when the source "
                  "says otherwise."),
    "persona_note": ("All personas below are fictional archetypes for M2 Swarm testing; they are not real people or real posts. "
                     "Stance axis for this case: -1.0 = sees Ethiopia's military build-up and sea-access push as a regional "
                     "threat, +1.0 = sees it as legitimate and stabilising."),
    "topics": "Topic codes: T01 deterrence and security; T02 sovereignty and recognition; T03 Nile and GERD; "
              "T04 cooperation and trade corridors.",
    "personas": [
        ("SIM01", "Ethiopian defence-policy student", "Ethiopia", "government-aligned", 0.7,
         "A modern air force and a future navy are about protecting trade routes, not threatening anyone.", "T01"),
        ("SIM02", "Ethiopian exporter", "Ethiopia", "pragmatic", 0.4,
         "I care about secure shipping lanes. Security partnerships matter if they keep costs down.", "T04"),
        ("SIM03", "Ethiopian opposition commentator", "Ethiopia", "government-critical", -0.4,
         "Spending on drones and jets should be weighed against inflation and conflicts at home.", "T01"),
        ("SIM04", "Tigrayan civil-society member", "Tigray, Ethiopia", "TPLF-aligned", -0.6,
         "We have seen what drones do to civilians. Any build-up worries communities near the border.", "T01"),
        ("SIM05", "Egyptian water engineer", "Egypt", "GERD-concerned", -0.6,
         "Egypt needs a binding agreement on filling and operations. Statements are not guarantees.", "T03"),
        ("SIM06", "Egyptian journalist", "Egypt", "sovereignty-focused", -0.5,
         "Red Sea security concerns every coastal state, which is why Egypt works with Somalia and Eritrea.", "T02"),
        ("SIM07", "Somali university lecturer", "Somalia", "sovereignty-focused", -0.6,
         "Any port arrangement must respect Somalia's borders. The Ankara process showed that dialogue works.", "T02"),
        ("SIM08", "Somaliland trader", "Somaliland", "recognition-supportive", 0.5,
         "Recognition and trade with Ethiopia would bring jobs, but we also need stability with our neighbours.", "T02"),
        ("SIM09", "Eritrean diaspora writer", "Eritrean diaspora", "security-focused", -0.7,
         "Talk about the Red Sea makes people in Assab anxious. Sovereignty is not negotiable.", "T02"),
        ("SIM10", "Djiboutian port manager", "Djibouti", "commercial", 0.2,
         "Djibouti serves Ethiopia's trade today. Competition is fine; instability is bad for everyone.", "T04"),
        ("SIM11", "Turkish foreign-policy analyst", "Türkiye", "mediation-focused", 0.2,
         "Ankara can talk to both Addis Ababa and Mogadishu. That bridge role is worth protecting.", "T04"),
        ("SIM12", "Gulf investment consultant", "United Arab Emirates", "investment-focused", 0.3,
         "Capital follows predictable corridors. Investors want de-escalation more than any one outcome.", "T04"),
        ("SIM13", "Saudi Red Sea researcher", "Saudi Arabia", "stability-focused", 0.0,
         "The priority is a calm Red Sea and respect for recognised borders, including Somalia's.", "T02"),
        ("SIM14", "Israeli Africa-policy researcher", "Israel", "partnership-focused", 0.4,
         "Ethiopia is a long-standing partner. Agriculture and technology ties matter as much as security.", "T04"),
        ("SIM15", "Regional peace researcher", "Regional", "analytical", 0.0,
         "Overlapping pacts make miscalculation more likely. Confidence-building measures are overdue.", "T01"),
    ],
    "scenarios": [
        ("Red Sea access talks resume", "Ethiopia and a coastal state open talks on a commercial corridor; observe how "
         "security-focused and trade-focused personas respond."),
        ("GERD negotiations restart", "A new round of Nile talks is announced; test whether cooperation topics gain over "
         "security framing."),
        ("Recognition cascade", "A second state signals recognition of Somaliland; compare sovereignty and trade reactions."),
        ("Capability misinformation", "A false claim about a new weapons delivery circulates; test verification and "
         "correction behaviour without attributing invented statements to real governments."),
    ],
    "settings": [
        ("Case title", "Ethiopia's Military Capability and Regional Alignments (ETH-SEC-002)"),
        ("Research question", "Section 1 of this document."),
        ("Primary scope", "Country"),
        ("Tags", "ethiopia, horn of africa, red sea, egypt, eritrea, somalia, turkiye, saudi arabia, uae, israel, gerd"),
        ("Entity types", "All seven"),
        ("Environment", "Focus issue: Red Sea / sea access; real governments context-only; import section 7 personas"),
        ("Simulation", "24 rounds; 1-2 LLM-written posts per round on a CPU-only machine"),
    ],
    "sources": [
        ("S01", "Capital FM / AFP, 16 September 2018 - Ethiopia, Eritrea seek to bolster truce at Saudi summit.",
         "https://capitalfm.africa/ethiopia-eritrea-seek-to-bolster-truce-at-saudi-summit/"),
        ("S02", "UAE Ministry of Foreign Affairs, 16 September 2018 - UAE at the Jeddah signing.",
         "https://www.mofa.gov.ae/en/mediahub/news/2019/2018/9/16/16-09-2018-uae-jeddah"),
        ("S03", "Somaliland Chronicle, 13 March 2019 - Ethiopia and France sign military and navy deal.",
         "https://somalilandchronicle.com/2019/03/13/ethiopia-france-sign-military-navy-deal-turn-new-page-in-ties/"),
        ("S04", "PAX - Turkish drones join Ethiopia's war, satellite imagery confirms.",
         "https://paxforpeace.nl/news/turkish-drones-join-ethiopias-war-satellite-imagery-confirms/"),
        ("S05", "Digit (site36), 5 January 2022 - War in Ethiopia: armed drones could again be a game changer.",
         "https://digit.site36.net/2022/01/05/war-in-ethiopia-armed-drones-could-be-again-a-gamechanger/"),
        ("S06", "The EastAfrican - US: Iran supplied Ethiopia with armed drones in Tigray war.",
         "https://theeastafrican.co.ke/tea/news/eastern-africa/us-iran-gave-ethiopia-armed-drones-in-tigray-war-3991732"),
        ("S07", "Overt Defense - Ethiopian Air Force receives Russian Su-30 aircraft and Turkish Akinci UAVs.",
         "https://overtdefense.com/tag/su-30"),
        ("S08", "Citizen Digital (Reuters) - Somalia rejects port deal between Ethiopia and Somaliland.",
         "https://citizen.digital/article/somalia-rejects-port-deal-between-ethiopia-and-somaliland-n334107"),
        ("S09", "The Defense Post, 22 February 2024 - Somalia defense deal with Turkey.",
         "https://thedefensepost.com/2024/02/22/somalia-defense-deal-turkey/amp/"),
        ("S10", "Al Jazeera, 10 October 2024 - Somalia, Eritrea and Egypt pledge to bolster security ties.",
         "https://www.aljazeera.com/news/2024/10/10/somalia-eritera-and-egypt-pledge-to-bloster-security-ties"),
        ("S11", "Daily News Egypt - Egypt, Eritrea, Somalia leaders hold tripartite summit in Asmara.",
         "https://www.dailynewsegypt.com/?p=821995"),
        ("S12", "Türkiye MFA, 11 December 2024 - Ankara Declaration.",
         "https://www.mfa.gov.tr/etiyopya-federal-demokratik-cumhuriyeti-ve-somali-federal-cumhuriyeti-nin-ankara-bildirisi.en.mfa"),
        ("S13", "Times of Israel - Netanyahu looks to boost security coordination with Ethiopia (2025 contacts).",
         "https://www.timesofisrael.com/liveblog_entry/netanyahu-looks-to-boost-security-coordination-with-ethiopia/"),
        ("S14", "Al-Monitor, September 2025 - Ethiopia inaugurates Africa's biggest dam, drawing Egyptian protest.",
         "https://www.al-monitor.com/originals/2025/09/ethiopia-inaugurates-africas-biggest-dam-drawing-egyptian-protest"),
        ("S15", "Khaleej Times, December 2025 - Somalia, African nations condemn Israel's recognition of Somaliland.",
         "https://www.khaleejtimes.com/world/africa/somalia-african-nations-condemn-israel-recognition-somaliland"),
        ("S16", "Egypt Independent, December 2025 - Israel becomes first country to formally recognize Somaliland.",
         "https://www.egyptindependent.com/israel-becomes-first-country-to-formally-recognize-somaliland-as-independent-state/"),
        ("S17", "AllAfrica, 25 February 2026 - Israeli President arrives in Addis Ababa for two-day official visit.",
         "https://allafrica.com/stories/202602250221.html"),
        ("S18", "Africanews, 9 February 2026 - Ethiopia-Eritrea tensions: fears of armed confrontation grow.",
         "https://www.africanews.com/2026/02/09/ethiopia-eritrea-tensions-fears-of-armed-confontation-grow/"),
    ],
}

if __name__ == "__main__":
    for c in (TIGRAY, MILITARY):
        print(build(c))
