/*
 * views/method.js — "Method": how the numbers are made, and the assumptions behind them.
 *
 * A field manual in nine sections with a sticky contents list (a "Jump to" select on phones):
 *   01 How it works        the physics chain from meter reading to 20-year payback, and its accuracy
 *   02 Data sources        every source with what it is used for and its licence / attribution
 *   03 Prices & VAT        as-billed vs forward valuation, the April 2026 levy cut, the VAT timeline
 *   04 The rules           dated regulation timeline with links, and what each route means legally
 *   05 Assumptions         finance defaults, editable; changes are staged behind the re-run bar
 *   06 Where panels go     the mount-spots editor (kind, direction, tilt, panels, shading)
 *   07 Limitations         what the model can't know, and catalog price dates
 *   08 Export & import     half-hourly CSV per scenario; settings/scenarios JSON (never the key)
 *   09 Reset               wipe everything this browser holds
 *
 * Deep links: #method?s=<section id>. Works without a dataset (only the CSV export needs one).
 *
 * View-specific components (prefixed mv-, styles injected once as #style-method): the chain
 * diagram, the VAT timeline strip, the rules timeline, the staged assumptions form and the
 * spot editor cards.
 */

import { DEFAULT_FINANCE } from '../finance.js';

const STYLE_ID = 'style-method';

const CSS = `
.mv-layout { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 36px; align-items: start; }
.mv-toc { position: sticky; top: 70px; }
.mv-toc-t { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); margin: 0 0 8px; }
.mv-toc ol { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--border); }
.mv-toc a {
    display: grid; grid-template-columns: 26px minmax(0, 1fr); align-items: center; min-height: 34px; margin-left: -1px; padding: 4px 8px 4px 12px;
    border-left: 2px solid transparent; color: var(--muted); font-size: 13.5px; text-decoration: none; line-height: 1.3;
}
.mv-toc a:hover { color: var(--text); }
.mv-toc a[aria-current='true'] { color: var(--text); border-left-color: var(--accent); }
.mv-toc a span:first-child { font-family: var(--font-mono); font-size: 10.5px; color: var(--faint); }
.mv-toc a[aria-current='true'] span:first-child { color: var(--accent); }
.mv-jump { display: none; }
.mv-main { display: flex; flex-direction: column; gap: 56px; min-width: 0; max-width: 900px; }
.mv-sec { scroll-margin-top: 70px; min-width: 0; }
.mv-sec-head { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 14px; align-items: baseline; margin-bottom: 18px; }
.mv-sec-n { font-family: var(--font-mono); font-size: 12px; color: var(--accent); }
.mv-sec-head h2 { font-size: 21px; letter-spacing: -.02em; }
.mv-sec-head p { grid-column: 2; color: var(--muted); font-size: 14px; max-width: 68ch; }
.mv-prose { color: var(--text-2); font-size: 14.5px; line-height: 1.65; max-width: 70ch; }
.mv-prose + .mv-prose { margin-top: 10px; }
.mv-prose b { color: var(--text); font-weight: 600; }

.mv-chain { list-style: none; margin: 0; padding: 0; position: relative; }
.mv-lane { display: flex; align-items: center; gap: 10px; margin: 18px 0 8px; font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.mv-lane:first-child { margin-top: 0; }
.mv-lane::after { content: ''; flex: 1; height: 1px; background: var(--hairline); }
.mv-node { position: relative; display: grid; grid-template-columns: 34px minmax(0, 1fr) minmax(0, 190px); gap: 2px 16px; padding: 10px 0 12px; }
.mv-node::before { content: ''; position: absolute; left: 16px; top: 34px; bottom: -10px; width: 1px; background: var(--border-strong); }
.mv-node:last-child::before, .mv-node.is-last::before { display: none; }
.mv-node-n {
    position: relative; z-index: 1; display: grid; place-items: center; width: 33px; height: 24px; border: 1px solid var(--border-strong);
    border-radius: 6px; background: var(--surface); font-family: var(--font-mono); font-size: 11px; color: var(--text-2);
}
.mv-node.is-key .mv-node-n { border-color: var(--accent); color: var(--accent); }
.mv-node-t { font-weight: 600; font-size: 14.5px; color: var(--text); }
.mv-node-d { grid-column: 2; font-size: 13.5px; color: var(--muted); line-height: 1.55; }
.mv-node-m { grid-column: 3; grid-row: 1 / span 2; justify-self: end; text-align: right; font-family: var(--font-mono); font-size: 11px; color: var(--text-2); line-height: 1.5; padding-top: 2px; }

.mv-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: stretch; }
.mv-basis .card-body { display: grid; gap: 8px; align-content: start; }
.mv-basis h3 { font-size: 15px; }
.mv-basis ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; color: var(--text-2); font-size: 13.5px; line-height: 1.5; }
.mv-basis .mv-tag { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }

.mv-vat { margin-top: 18px; }
.mv-vat-grid { display: grid; grid-template-columns: repeat(var(--months), minmax(0, 1fr)); row-gap: 6px; }
.mv-vat-seg { height: 30px; display: flex; align-items: center; justify-content: center; border-radius: 4px; margin-right: 2px; font-family: var(--font-mono); font-size: 12px; font-weight: 600; overflow: hidden; white-space: nowrap; }
.mv-vat-seg.is-5 { background: var(--surface-3); color: var(--text); border: 1px solid var(--border-strong); }
.mv-vat-seg.is-0 { background: var(--accent-dim); color: var(--accent-strong); border: 1px solid var(--accent-line); }
.mv-vat-br { position: relative; height: 26px; margin-right: 2px; border: 1px solid var(--border-strong); border-top: 0; border-radius: 0 0 5px 5px; font-size: 11.5px; color: var(--text-2); display: flex; align-items: flex-end; justify-content: center; padding-bottom: 3px; white-space: nowrap; overflow: hidden; }
.mv-vat-br.is-y1 { border-color: var(--accent-line); color: var(--accent-strong); }
.mv-vat-ticks { display: grid; grid-template-columns: repeat(var(--months), minmax(0, 1fr)); font-family: var(--font-mono); font-size: 10.5px; color: var(--faint); margin-top: 4px; }
.mv-vat-ticks span { white-space: nowrap; overflow: visible; }

.mv-rules { list-style: none; margin: 0; padding: 0; display: grid; }
.mv-rule { display: grid; grid-template-columns: 112px 18px minmax(0, 1fr); gap: 0 14px; position: relative; padding-bottom: 22px; }
.mv-rule-date { font-family: var(--font-mono); font-size: 12px; color: var(--text-2); text-align: right; padding-top: 1px; }
.mv-rule-dot { position: relative; display: flex; justify-content: center; }
.mv-rule-dot::before { content: ''; width: 11px; height: 11px; margin-top: 4px; border-radius: 50%; border: 2px solid var(--accent); background: var(--surface); position: relative; z-index: 1; }
.mv-rule-dot::after { content: ''; position: absolute; top: 14px; bottom: -26px; width: 1px; background: var(--border-strong); }
.mv-rule:last-child .mv-rule-dot::after { display: none; }
.mv-rule.is-now .mv-rule-dot::before { background: var(--accent); }
.mv-rule-t { font-weight: 600; font-size: 14.5px; color: var(--text); }
.mv-rule-d { margin-top: 3px; font-size: 13.5px; line-height: 1.55; color: var(--muted); max-width: 64ch; }
.mv-rule-l { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 13px; }
.mv-rule-l a { display: inline-flex; align-items: center; gap: 5px; }
.mv-routes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 8px; }
.mv-route { display: grid; gap: 8px; align-content: start; padding: 16px 18px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.mv-route.is-whatif { border-style: dashed; }
.mv-route-t { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-weight: 600; font-size: 15px; }
.mv-route ul { margin: 0; padding-left: 18px; display: grid; gap: 5px; font-size: 13.5px; color: var(--text-2); line-height: 1.5; }

.mv-form { display: grid; gap: 22px; }
.mv-group-t { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; display: flex; align-items: center; gap: 10px; }
.mv-group-t::after { content: ''; flex: 1; height: 1px; background: var(--hairline); }
.mv-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 16px 18px; align-items: start; }
/* The dot is decoration (alt text '' where supported); screen readers get the .mv-sr text instead. */
.mv-field.is-changed .field-label::after, .mv-field.is-changed .mv-tlabel::after { content: '•'; content: '•' / ''; color: var(--accent); margin-left: 6px; }
.mv-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; display: none; }
.mv-field.is-changed .mv-sr { display: inline; }
.mv-field .field-hint b { color: var(--text-2); font-weight: 500; font-family: var(--font-mono); font-size: 11.5px; }
.mv-staged { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 14px; border: 1px solid var(--accent-line); border-radius: var(--radius-sm); background: var(--accent-dim); font-size: 14px; color: var(--text); }
.mv-staged-acts { display: flex; gap: 8px; flex-wrap: wrap; }

.mv-spots { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.mv-spot { display: grid; gap: 14px; align-content: start; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--sunk); }
.mv-spot-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mv-spot-n { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); }
.mv-spot-dir { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 14px; align-items: center; }
.mv-spot-any { display: flex; align-items: center; gap: 10px; min-height: 60px; padding: 10px 12px; border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); font-size: 13.5px; color: var(--text-2); }
.mv-spot-any .icon { color: var(--accent); }
.mv-spot-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 12px; }
.mv-spot-add { display: grid; place-items: center; min-height: 96px; border: 1.5px dashed var(--border-strong); border-radius: var(--radius); background: transparent; color: var(--text-2); cursor: pointer; font-size: 14px; font-weight: 600; }
.mv-spot-add:hover { border-color: var(--accent); color: var(--accent); }
.mv-spot-add:disabled { opacity: .5; cursor: not-allowed; }

.mv-limits { list-style: none; margin: 0; padding: 0; display: grid; }
.mv-limit { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 18px; padding: 14px 0; border-top: 1px solid var(--hairline); }
.mv-limit:first-child { border-top: 0; padding-top: 0; }
.mv-limit-t { font-weight: 600; font-size: 14.5px; color: var(--text); }
.mv-limit-d { grid-column: 1; font-size: 13.5px; color: var(--muted); line-height: 1.55; max-width: 68ch; }
.mv-limit-m { grid-column: 2; grid-row: 1 / span 2; align-self: start; font-family: var(--font-mono); font-size: 12px; color: var(--text-2); text-align: right; white-space: nowrap; padding: 3px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--sunk); }

.mv-export { display: grid; gap: 0; }
.mv-x { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 20px; align-items: center; padding: 16px 0; border-top: 1px solid var(--hairline); }
.mv-x:first-child { border-top: 0; padding-top: 0; }
.mv-x:last-child { padding-bottom: 0; }
.mv-x-t { font-weight: 600; font-size: 14.5px; }
.mv-x-d { font-size: 13px; color: var(--muted); margin-top: 2px; line-height: 1.5; max-width: 60ch; }
.mv-x-acts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.mv-x-acts .select { min-width: 240px; max-width: 320px; }
.mv-file { position: relative; overflow: hidden; }
.mv-file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.mv-danger { border-color: rgba(217, 112, 95, 0.45); }
.mv-sec .tbl td, .mv-sec .tbl th { overflow-wrap: break-word; }
@media (max-width: 600px) { .mv-sec .tbl td, .mv-sec .tbl th { overflow-wrap: anywhere; } .mv-sec .tbl tbody .m-show { flex-direction: column; align-items: flex-start; gap: 1px; } .mv-sec .tbl tbody .m-show.al-right { text-align: left; } }
.mv-sec .tbl td > *, .mv-sec .tbl th > * { min-width: 0; }

@media (max-width: 1023px) {
    .mv-layout { grid-template-columns: minmax(0, 1fr); gap: 20px; }
    .mv-toc { display: none; }
    .mv-jump { display: block; position: sticky; top: 52px; z-index: 5; padding: 8px 0; background: rgba(15, 15, 12, 0.92); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
    .mv-main { gap: 44px; }
    .mv-routes { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 760px) {
    .mv-two, .mv-spots { grid-template-columns: minmax(0, 1fr); }
    .mv-node { grid-template-columns: 34px minmax(0, 1fr); }
    .mv-node-m { grid-column: 2; grid-row: auto; justify-self: start; text-align: left; padding-top: 4px; }
    .mv-x { grid-template-columns: minmax(0, 1fr); }
    .mv-x-acts { justify-content: stretch; }
    .mv-x-acts > * { flex: 1 1 auto; }
    .mv-x-acts .select { min-width: 0; max-width: none; width: 100%; }
}
@media (max-width: 600px) {
    .mv-jump { top: 44px; }
    .mv-sec-head h2 { font-size: 19px; }
    .mv-sec-head p { grid-column: 1 / -1; }
    .mv-rule { grid-template-columns: 18px minmax(0, 1fr); gap: 0 12px; }
    .mv-rule-date { grid-column: 2; grid-row: 1; text-align: left; color: var(--accent); }
    .mv-rule-dot { grid-column: 1; grid-row: 1 / span 4; }
    .mv-rule-body { grid-column: 2; }
    .mv-limit { grid-template-columns: minmax(0, 1fr); }
    .mv-limit-m { grid-column: 1; grid-row: auto; justify-self: start; margin-top: 4px; }
    .mv-spot-3 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .mv-spot-dir { grid-template-columns: minmax(0, 1fr); justify-items: center; }
    .mv-vat-seg { font-size: 10.5px; }
    .mv-vat-br { font-size: 10px; }
    .mv-staged .btn { flex: 1; }
    .mv-sec .tbl tbody th > a, .mv-sec .tbl tbody td > a, .mv-rule-l a { display: inline-flex; align-items: center; min-height: 44px; }
}
@media print {
    .mv-layout { grid-template-columns: minmax(0, 1fr); }
    .mv-toc, .mv-jump, .mv-sec[data-sec='assumptions'] .mv-staged, .mv-sec[data-sec='export'], .mv-sec[data-sec='reset'], .mv-spot-add { display: none !important; }
}
`;

const SECTIONS = [
    { id: 'how', n: '01', title: 'How it works', lede: 'Ten steps from a meter reading to a 20-year payback. Every tab uses this same chain.' },
    { id: 'sources', n: '02', title: 'Data sources', lede: 'Where each number comes from, and the licence it comes with.' },
    { id: 'prices', n: '03', title: 'Prices, VAT and the levy', lede: 'Last year’s half-hours, valued two ways: as you were billed, and as they’d be billed from now on.' },
    { id: 'rules', n: '04', title: 'The rules', lede: 'What’s legal in Great Britain as of 5 October 2026, and what each route means.' },
    { id: 'assumptions', n: '05', title: 'Assumptions', lede: 'The money side. Change any of these and every result re-runs.' },
    { id: 'spots', n: '06', title: 'Where panels can go', lede: 'Each option is placed on the best of these spots. Tell us what your home really has.' },
    { id: 'limits', n: '07', title: 'Limitations', lede: 'What the model can’t know, and how much each one could move the answer.' },
    { id: 'export', n: '08', title: 'Export and import', lede: 'Take the half-hourly results with you, or move your settings to another browser.' },
    { id: 'reset', n: '09', title: 'Reset', lede: 'Start again from nothing.' },
];

const CHAIN = [
    { lane: 'Inputs', n: '01', t: 'Your half-hours', d: 'Smart-meter kWh for every half-hour of the latest full year, joined to the price of that exact half-hour (never by position in a list, so clock changes can’t shift anything).', m: 'Octopus API' },
    { lane: 'Inputs', n: '02', t: 'Sunshine at your home', d: 'Satellite irradiance for your 5 km grid cell, every half-hour. Gaps come from a second satellite, then a weather model — never zeros.', m: 'SARAH-3 → MSG → IFS', key: true },
    { lane: 'Solar physics', n: '03', t: 'Where the sun is', d: 'The sun’s position three times per half-hour, with each half-hour’s sunshine shared out by how clear the sky was.', m: 'NOAA solar position' },
    { lane: 'Solar physics', n: '04', t: 'Light on the panel', d: 'Direct, sky and ground-reflected light on the panel’s tilt and direction, less reflection off the glass, shading and your horizon.', m: 'Perez 1990 · Martin–Ruiz' },
    { lane: 'Solar physics', n: '05', t: 'Panel temperature', d: 'Hot panels make less. Temperature comes from sunshine, air temperature and wind, for how the panel is mounted.', m: 'Faiman' },
    { lane: 'Solar physics', n: '06', t: 'Panel output', d: 'Output at the panel’s −0.30%/°C temperature coefficient with low-light losses, less 5.9% for dirt, wiring, mismatch, first-year ageing and downtime, and 3% for shading.', m: 'PVWatts + low-light' },
    { lane: 'Solar physics', n: '07', t: 'Inverter and the 800 W limit', d: 'Efficiency at each power level. Each solar input’s limit and the 800 W cap are applied every 10 minutes, so peaks above the cap are lost correctly.', m: 'PVWatts inverter', key: true },
    { lane: 'Money', n: '08', t: 'Battery or power station', d: 'Charge level tracked half-hour by half-hour. Realistic: a price-threshold rule that guesses today’s sun from yesterday’s. Best case: the cheapest plan with perfect hindsight.', m: 'Threshold rule · DP' },
    { lane: 'Money', n: '09', t: 'Your bill, twice', d: 'Every half-hour valued as billed (last year’s prices and VAT) and forward (today’s prices and the VAT schedule). Import saved, export paid, standby power counted.', m: 'As billed · forward', key: true },
    { lane: 'Money', n: '10', t: 'Years of money', d: 'A typical year of sunshine, prices rising each year, panels ageing, battery fade and replacements, discounted to today.', m: 'Payback · NPV · IRR' },
];

const IPS_URL = 'https://assets.publishing.service.gov.uk/media/6a60a03c47af652afa0c89f5/plug-in-solar-final-_interim-product-specification.pdf';
const OFGEM_URL = 'https://www.ofgem.gov.uk/sites/default/files/2026-08/Ofgem-decision-to-Approve-DCRP-MP-26-02-Proposed-Amendment-to-facilitate-Plug-in-Microgeneration.pdf';
const SI_URL = 'https://www.legislation.gov.uk/uksi/2026/848/made';

const RULES = [
    {
        date: '15 Apr 2026', t: 'Wiring Regulations amendment 4 published',
        d: 'BS 7671:2018+A4:2026. It did not itself allow plugging generation into a socket (regulation 551.7 is unchanged) — that came from the law below. Amendment 3 is withdrawn on 15 Oct 2026.',
        links: [['NICEIC on Amendment 4', 'https://niceic.com/amendment-four']],
    },
    {
        date: 'Jul 2026', t: 'Plug-in solar product specification, version 2.0',
        d: 'The government’s interim specification: at most 800 VA (3.5 A) out and 2,000 W of panels, no more than 4 panels with at most 2 in series, sold as a complete kit. A professional check is advised above 960 W of panels.',
        links: [['Interim Product Specification (PDF)', IPS_URL]],
    },
    {
        date: '11 Aug 2026', t: 'Ofgem approves the G98 change',
        d: 'One plug-in device per home, notified to your network operator. Plug-in electricity storage stays prohibited. All small generation in a home together must stay within 16 A per phase (about 3.68 kW).',
        links: [['Ofgem decision DCRP/MP/26/02 (PDF)', OFGEM_URL]],
    },
    {
        date: '27 Aug 2026', t: 'Plug-in solar becomes legal in Great Britain',
        d: 'SI 2026/848 (made 16 Jul 2026, in force 27 Aug) defines a plug-in microgenerator: sunlight only, at most 800 W, a standard plug — and not designed to store energy for later, which is why plug-in batteries stay illegal. It also amends ESQCR. Not yet legal in Northern Ireland.',
        links: [['SI 2026/848 on legislation.gov.uk', SI_URL]],
    },
    {
        date: 'Before use', t: 'Register at myplugin.solar', now: true,
        d: 'Registering a plug-in kit is a legal requirement (the register is run by the Energy Networks Association). Plug it straight into a socket on an RCD-protected circuit — no extension leads or adaptors.',
        links: [['myplugin.solar', 'https://myplugin.solar/']],
    },
];

const ROUTES = [
    {
        tone: 'plugin', name: 'Plug into a socket (DIY)', badge: 'Legal now',
        items: ['Up to 800 W out and 2,000 W of panels; one kit per home; register it.',
            'Export is unpaid: no MCS certificate means no Smart Export Guarantee.',
            'Exception: a kit bought from Octopus, in a home Octopus supplies, can join Outgoing Prime (16p 4–7pm, 9p otherwise) once your network operator approves.',
            'Above-ground mounting (balconies, walls) needs a suitably qualified professional’s advice.'],
    },
    {
        tone: 'hardwired', name: 'Wired in by an electrician', badge: 'Needed for any battery',
        items: ['A Part P electrician fits a dedicated circuit and notifies G98: we assume £350 (typically £150–600, plus £400–900 if the consumer unit needs replacing).',
            'Up to 16 A per phase, about 3.68 kW, including any plug-in kit.',
            'Bought through an installer, panels and batteries can be 0% VAT until 31 Mar 2027 — DIY prices include 20%.'],
    },
    {
        tone: 'ups', name: 'Power station for the servers', badge: 'No registration',
        items: ['Charges from a socket and runs the servers from its own outlets. It never runs in parallel with the grid, so it is outside G98, ESQCR regulation 22 and the plug-in battery ban.',
            'Never feed a socket or the house wiring from it. Keep its bypass (pass-through) on — running the servers through its inverter all the time wastes far more than it saves.',
            'Panels on its own solar inputs are fine; nothing is exported.'],
    },
    {
        tone: 'whatif', name: 'Future rules (not legal yet)', badge: 'What-if only',
        items: ['Plug-in batteries: Octopus hopes for early 2027. More than one kit per home.',
            'Shown as hollow rings and never recommended as a purchase.'],
    },
];

const LIMITS = [
    { t: 'Best case means perfect hindsight', m: 'battery: +5–15%', d: 'The best-case battery plan knows every future price and cloud. Real controllers don’t; the realistic rule guesses today’s sun from yesterday’s and earns roughly 85–95% of the best case.' },
    { t: 'Any single half-hour is uncertain', m: '±20–27% per half-hour', d: 'Satellite sunshine for one half-hour can be well out (a passing cloud). Over a year these errors mostly cancel: about ±1–2% on annual output.' },
    { t: 'Weather changes year to year', m: '−5% to +7% a year', d: 'Results use a typical year: each month’s sunshine scaled to its 2006–2025 average for your home. In London the sunniest and dullest of those years were about 12% apart, and the 12 months to September 2026 were sunnier than any of them. The range across all 20 years is shown as a band.' },
    { t: 'Lost to the 800 W limit, 10 minutes at a time', m: 'oversized arrays: small', d: 'The 800 W limit is applied to 10-minute estimates. Shorter bright spikes at cloud edges are smoothed, so what is lost to the limit is slightly understated for arrays well above 800 W.' },
    { t: 'You’ll use electricity like last year', m: 'your call', d: 'Savings assume next year’s usage matches the last 12 months — unless you project today’s always-on load from the Usage tab. Adding or retiring servers changes the answer more than anything else here.' },
    { t: 'Future prices', m: 'you set the rise', d: 'Agile follows wholesale prices. We repeat last year’s half-hourly pattern at today’s levels and raise it each year by the escalation in Assumptions. Prices could fall as well as rise.' },
    { t: 'Estimated physics', m: 'wall / railing / bifacial', d: 'Temperature settings for railing and wall mounts, and the extra from the back of bifacial panels, are estimates rather than measured values. Vertical bifacial gains in particular may be optimistic.' },
    { t: 'Catalog prices go stale', m: 'checked 3–5 Oct 2026', d: 'Kit and power-station prices were read from retailer pages on the dates below. Sales come and go — edit any price in Compare or Design.' },
    { t: 'Not advice', m: '', d: 'This is an estimate from your own data to help you decide, not financial or electrical advice. An electrician’s survey beats any model for what your home can actually take.' },
];

/* Mount-spot defaults (UX critique): used when the user hasn't set any spots. */
const DEFAULT_SPOTS = [
    { id: 'ground', name: 'Ground or flat-roof frame', kind: 'ground', azimuth: null, tilt: null, tiltRange: [15, 45], maxPanels: 4, shadingPct: 3, horizon: [], groundLevel: true },
    { id: 'west-wall', name: 'West-facing wall', kind: 'wall', azimuth: 270, tilt: 90, tiltRange: [90, 90], maxPanels: 2, shadingPct: 3, horizon: [], groundLevel: true },
];
const SPOT_KINDS = [
    { value: 'ground', label: 'Ground or garden frame', any: true, range: [15, 45] },
    { value: 'flatroof', label: 'Flat roof frame', any: true, range: [15, 45] },
    { value: 'wall', label: 'Wall (vertical)', any: false, fixedTilt: 90 },
    { value: 'railing', label: 'Balcony railing', any: false, range: [60, 90] },
    { value: 'pitched', label: 'Pitched roof (electrician only)', any: false, fixedTilt: 35 },
];
const MAX_SPOTS = 4;
const MAX_SPOT_NAME = 60;

/* Assumption fields. scale converts the stored value to what's shown (fractions → %). */
const FIN_GROUPS = [
    {
        title: 'Timing', fields: [
            { key: 'installDate', label: 'Year 1 starts', kind: 'month', hint: 'Savings are counted from the 1st of this month.' },
            { key: 'years', label: 'Years to count', unit: 'yrs', min: 1, max: 40, step: 1, hint: 'How far the payback and net-gain figures look.' },
        ],
    },
    {
        title: 'Money', fields: [
            { key: 'escalation', label: 'Electricity prices rise by', unit: '%/yr', scale: 100, min: -5, max: 15, step: 0.5, hint: 'Applied to every year after the first.' },
            { key: 'discountRate', label: 'Discount rate', unit: '%', scale: 100, min: 0, max: 15, step: 0.5, hint: 'What money is worth to you, e.g. your savings rate. Used for NPV.' },
            { key: 'vatReturns', label: 'VAT on electricity returns to 5% in April 2027', kind: 'toggle', settings: true, hint: 'Off: assume the 0% rate is extended.' },
            { key: 'maxPaybackYears', label: 'Worth it if it pays back within', unit: 'yrs', min: 1, max: 25, step: 1, settings: true, def: 10, hint: 'The verdict’s cut-off for a recommendation.' },
            { key: 'omGbpPerYear', label: 'Upkeep per year', unit: '£', min: 0, max: 1000, step: 5, hint: 'Cleaning, insurance, apps — anything recurring.' },
        ],
    },
    {
        title: 'Panels and inverters', fields: [
            { key: 'pvFirstYearDeg', label: 'Extra panel ageing in year 1', unit: '%', scale: 100, min: 0, max: 5, step: 0.1, hint: 'The usual 1% first-year drop is already in the panel losses.' },
            { key: 'pvAnnualDeg', label: 'Panel ageing each year after', unit: '%', scale: 100, min: 0, max: 3, step: 0.05, hint: 'Typical TOPCon warranty: 0.4% a year.' },
            { key: 'microReplaceYear', label: 'Replace the micro-inverter in year', unit: '', min: 0, max: 40, step: 1, hint: '0 means never. Battery units replace theirs when the battery wears out.' },
            { key: 'microReplaceGbp', label: 'Replacement inverter costs', unit: '£', min: 0, max: 2000, step: 10, hint: 'A plain 800 W micro-inverter.' },
        ],
    },
    {
        title: 'Batteries', fields: [
            { key: 'batteryCalendarFade', label: 'Battery loses each year, unused', unit: '%', scale: 100, min: 0, max: 10, step: 0.1, hint: 'Calendar ageing, on top of wear from cycling.' },
            { key: 'batteryEolSoh', label: 'Battery is worn out at', unit: '%', scale: 100, min: 50, max: 95, step: 1, hint: 'Capacity left, as a share of new.' },
            { key: 'replaceBattery', label: 'Buy a new battery when it wears out', kind: 'toggle', hint: 'Off: savings from the battery stop at end of life.' },
        ],
    },
];

const finite = v => typeof v === 'number' && Number.isFinite(v);
const isAbort = err => err?.name === 'AbortError';
const clone = v => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function injectStyle() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
}

function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** First of the month after `ms`, as 'YYYY-MM-01'. */
function firstOfNextMonth(ms = Date.now()) {
    const d = new Date(ms);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    return `${m > 11 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, '0')}-01`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthIndex = iso => { const m = /^(\d{4})-(\d{2})/.exec(iso || ''); return m ? +m[1] * 12 + (+m[2] - 1) : NaN; };
const monthName = idx => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;

/** The focusable control in (or at) a [data-fk] holder: a checked radio, a field, a button or a dial. */
function controlIn(holder) {
    if (!holder) return null;
    if (holder.matches('input, select, textarea, button, [tabindex]:not([tabindex="-1"])')) return holder;
    return holder.querySelector('[role="radio"][aria-checked="true"], input, select, textarea, button, [tabindex]:not([tabindex="-1"])');
}

/** 2 → '2', 0.4 → '0.4', 0.004 → '0.004' (no padding zeros in hints). */
const plain = v => (Number.isFinite(v) ? String(+v.toFixed(4)) : '—');

const isPlainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const FIN_FIELDS = new Map(FIN_GROUPS.flatMap(g => g.fields).map(f => [f.key, f]));
const GB_BOUNDS = { lat: [49.8, 60.9], lon: [-8.7, 1.8] };

/**
 * Check a settings file before anything from it is shown or stored. Only keys this page can
 * edit survive, each with the right type and inside its field's range; anything else is listed
 * in `ignored` (in words, for the preview). Never returns an API key, a source kind or unknown keys.
 * Pure (no DOM), exported for tests.
 * @param {object} json  parsed file ({ app, version, settings, scenarios, connection })
 * @param {{ normalizeAccount?: (s: string) => { value: string|null, valid: boolean } }} [o]
 * @returns {{ settings: object|null, scenarios: object|null, connection: object|null, ignored: string[] }}
 */
export function sanitizeImport(json, { normalizeAccount = null } = {}) {
    const ignored = [];
    const skip = what => ignored.push(what);
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    let settings = null;
    if (isPlainObj(json?.settings)) {
        const s = json.settings;
        settings = { finance: {} };
        if (isPlainObj(s.finance)) {
            for (const [k, v] of Object.entries(s.finance)) {
                const f = FIN_FIELDS.get(k);
                if (!f || f.settings) { skip(`an unknown assumption “${String(k).slice(0, 30)}”`); continue; }
                if (f.kind === 'toggle') { if (typeof v === 'boolean') settings.finance[k] = v; else skip(`“${f.label}” (not on/off)`); continue; }
                if (f.kind === 'month') {
                    if (typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(v)) settings.finance[k] = v;
                    else skip(`“${f.label}” (not a month)`);
                    continue;
                }
                const scale = f.scale || 1;
                const n = num(v);
                if (n == null || n * scale < f.min - 1e-9 || n * scale > f.max + 1e-9) { skip(`“${f.label}” (${n == null ? 'not a number' : 'out of range'})`); continue; }
                settings.finance[k] = n;
            }
        } else if (s.finance !== undefined) skip('the assumptions (not a list of values)');
        if (s.vatReturns !== undefined) { if (typeof s.vatReturns === 'boolean') settings.vatReturns = s.vatReturns; else skip('the VAT setting (not on/off)'); }
        if (s.maxPaybackYears !== undefined) {
            const n = num(s.maxPaybackYears);
            if (n != null && n >= 1 && n <= 25) settings.maxPaybackYears = Math.round(n); else skip('the payback cut-off (out of range)');
        }
        if (s.projectBaseW !== undefined && s.projectBaseW !== null) {
            const n = num(s.projectBaseW);
            if (n != null && n >= 0 && n <= 20_000) settings.projectBaseW = n; else skip('the projected always-on load (not a number of watts)');
        } else settings.projectBaseW = null;
        if (Array.isArray(s.spots)) {
            const spots = [];
            s.spots.forEach((sp, i) => {
                const kind = SPOT_KINDS.find(k => k.value === sp?.kind);
                if (!isPlainObj(sp) || !kind) { skip(`spot ${i + 1} (unknown kind)`); return; }
                if (spots.length >= MAX_SPOTS) { skip(`spot ${i + 1} (only ${MAX_SPOTS} spots are allowed)`); return; }
                const az = num(sp.azimuth);
                const tilt = num(sp.tilt);
                const range = Array.isArray(sp.tiltRange) && sp.tiltRange.length === 2 && sp.tiltRange.every(x => num(x) != null && x >= 0 && x <= 90) && sp.tiltRange[0] <= sp.tiltRange[1]
                    ? [sp.tiltRange[0], sp.tiltRange[1]] : kind.fixedTilt != null ? [kind.fixedTilt, kind.fixedTilt] : [...kind.range];
                const maxPanels = num(sp.maxPanels);
                const shading = num(sp.shadingPct);
                spots.push({
                    id: typeof sp.id === 'string' && sp.id.length <= 40 ? sp.id : `spot-${i + 1}`,
                    name: typeof sp.name === 'string' && sp.name.trim() ? sp.name.trim().slice(0, MAX_SPOT_NAME) : `Spot ${spots.length + 1}`,
                    kind: kind.value,
                    azimuth: az != null ? ((Math.round(az) % 360) + 360) % 360 : kind.any ? null : kind.value === 'wall' ? 270 : 180,
                    tilt: tilt != null && tilt >= 0 && tilt <= 90 ? tilt : kind.fixedTilt ?? null,
                    tiltRange: range,
                    maxPanels: maxPanels != null && maxPanels >= 1 && maxPanels <= 8 ? Math.round(maxPanels) : 2,
                    shadingPct: shading != null && shading >= 0 && shading <= 60 ? shading : 3,
                    horizon: Array.isArray(sp.horizon) && sp.horizon.every(x => num(x) != null) ? sp.horizon.slice(0, 72) : [],
                    groundLevel: typeof sp.groundLevel === 'boolean' ? sp.groundLevel : kind.value === 'ground' || kind.value === 'wall',
                });
            });
            settings.spots = spots;
        } else settings.spots = [];
    }

    let scenarios = null;
    if (isPlainObj(json?.scenarios)) {
        const sc = json.scenarios;
        const saved = [];
        for (const [i, x] of (Array.isArray(sc.saved) ? sc.saved : []).entries()) {
            if (isPlainObj(x) && typeof x.id === 'string' && x.id && x.id.length <= 80) { if (saved.length < 100) saved.push(x); else skip(`saved scenario ${i + 1} (over 100)`); }
            else skip(`saved scenario ${i + 1} (not a scenario)`);
        }
        const ids = new Set(saved.map(x => x.id));
        const pinned = (Array.isArray(sc.pinned) ? sc.pinned : []).filter(x => typeof x === 'string' && x.length <= 80).slice(0, 4);
        scenarios = { saved, pinned, activeId: typeof sc.activeId === 'string' && ids.has(sc.activeId) ? sc.activeId : null };
    }

    let connection = null;
    if (isPlainObj(json?.connection)) {
        const c = json.connection;
        connection = {};
        if (c.location !== undefined) {
            const l = isPlainObj(c.location) ? c.location : null;
            const pc = typeof l?.postcode === 'string' && /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$|^[A-Z]{1,2}\d[A-Z\d]?$/i.test(l.postcode.trim()) ? l.postcode.trim().toUpperCase() : null;
            const lat = num(l?.lat), lon = num(l?.lon);
            const inGb = lat != null && lon != null && lat >= GB_BOUNDS.lat[0] && lat <= GB_BOUNDS.lat[1] && lon >= GB_BOUNDS.lon[0] && lon <= GB_BOUNDS.lon[1];
            // A bad location is left out entirely, so it can't wipe the one already stored.
            if (!l || (l.postcode && !pc) || ((l.lat != null || l.lon != null) && !inGb)) skip('the location (not a UK postcode or map point)');
            else connection.location = { postcode: pc, lat: inGb ? lat : null, lon: inGb ? lon : null };
        }
        if (c.demoServerW !== undefined) { const n = num(c.demoServerW); if (n != null && n >= 0 && n <= 2000) connection.demoServerW = n; else skip('the example server load (out of range)'); }
        if (c.manual !== undefined) {
            const b = num(c.manual?.baseW), o = num(c.manual?.otherKwhYr);
            if (b != null && o != null && b >= 0 && b <= 5000 && o >= 0 && o <= 30_000) connection.manual = { baseW: b, otherKwhYr: o };
            else skip('the hand-entered usage (out of range)');
        }
        if (c.installedSolarDate !== undefined && c.installedSolarDate !== null) {
            if (typeof c.installedSolarDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.installedSolarDate) && Number.isFinite(Date.parse(c.installedSolarDate))) connection.installedSolarDate = c.installedSolarDate;
            else skip('the existing-solar date (not a date)');
        } else if (c.installedSolarDate === null) connection.installedSolarDate = null;
        if (c.priceBasis !== undefined) { if (['mine', 'agile', 'flexible', 'flat'].includes(c.priceBasis)) connection.priceBasis = c.priceBasis; else skip('the price basis (unknown)'); }
        if (c.flatP !== undefined && c.flatP !== null) { const n = num(c.flatP); if (n != null && n >= 1 && n <= 150) connection.flatP = n; else skip('the flat price (out of range)'); }
        if (c.accountNumber !== undefined && c.accountNumber !== null) {
            const a = normalizeAccount ? normalizeAccount(c.accountNumber) : { value: null, valid: false };
            if (typeof c.accountNumber === 'string' && a.valid && a.value) connection.accountNumber = a.value; else skip('the account number (not like A-1234ABCD)');
        }
        if ('apiKey' in c || 'key' in c) skip('an API key (keys are never imported)');
        if (!Object.keys(connection).length) connection = null;
    }
    return { settings, scenarios, connection, ignored };
}

function deleteCacheDb() {
    return new Promise(resolve => {
        try {
            const req = indexedDB.deleteDatabase('solar-calculator');
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
            req.onblocked = () => setTimeout(() => resolve(true), 1200);
        } catch { resolve(false); }
    });
}

export default {
    id: 'method',
    title: 'Method',

    mount(el, ctx) {
        injectStyle();
        this.el = el;
        this.ctx = ctx;
        this.params = {};
        this.visible = true;
        this.sync();
        this.render();
        this.offs = [
            ctx.data.on('dataset', () => { this.renderPrices(); this.renderExport(); this.renderSpots(); }),
            ctx.data.on('scenarios', () => this.renderExport()),
            ctx.data.on('settings', () => {
                if (this.dirty()) return;   // the user's staged edits win until applied or discarded
                this.sync();
                this.renderAssumptions();
                this.renderSpots();
                this.renderPrices();
            }),
        ];
    },

    show(params) {
        this.visible = true;
        if (this.exportStale) this.renderExport();
        const p = params || {};
        const target = p.s;
        this.params = p;
        if (this.dirty()) this.showRerun();
        if (target && SECTIONS.some(s => s.id === target)) {
            requestAnimationFrame(() => this.el.querySelector(`[data-sec="${target}"]`)?.scrollIntoView({ block: 'start' }));
        }
    },

    hide() {
        this.visible = false;
        if (this.dirty()) this.ctx.shell.rerun.hide();
    },

    unmount() {
        this.offs?.forEach(off => off());
        this.io?.disconnect();
        this.picker?.destroy?.();
    },

    /* ── staged settings ──────────────────────────────────────────────────── */

    /** Copy the stored settings into the staged copy the forms edit. */
    sync() {
        const s = this.ctx.store.get().settings;
        this.stage = {
            finance: clone(s.finance || {}),
            vatReturns: s.vatReturns !== false,
            maxPaybackYears: finite(s.maxPaybackYears) ? s.maxPaybackYears : 10,
            spots: clone(s.spots?.length ? s.spots : DEFAULT_SPOTS),
        };
    },

    /** The settings patch the staged copy would write (finance keeps only real overrides). */
    staged() {
        const fin = {};
        for (const [k, v] of Object.entries(this.stage.finance)) {
            if (v === undefined || v === null || v === '') continue;
            if (k in DEFAULT_FINANCE && same(v, DEFAULT_FINANCE[k])) continue;
            fin[k] = v;
        }
        const spots = same(this.stage.spots, DEFAULT_SPOTS) ? [] : this.stage.spots;
        return { finance: fin, vatReturns: this.stage.vatReturns, maxPaybackYears: this.stage.maxPaybackYears, spots };
    },

    dirty() {
        if (!this.stage) return false;
        const s = this.ctx.store.get().settings;
        const cur = { finance: s.finance || {}, vatReturns: s.vatReturns !== false, maxPaybackYears: finite(s.maxPaybackYears) ? s.maxPaybackYears : 10, spots: s.spots || [] };
        const next = this.staged();
        const fin = o => Object.fromEntries(Object.entries(o).filter(([k, v]) => !(k in DEFAULT_FINANCE && same(v, DEFAULT_FINANCE[k]))));
        return !same(fin(cur.finance), next.finance) || cur.vatReturns !== next.vatReturns || cur.maxPaybackYears !== next.maxPaybackYears || !same(cur.spots, next.spots);
    },

    changed() {
        const d = this.dirty();
        this.paintStaged(d);
        if (d) this.showRerun(); else this.ctx.shell.rerun.hide();
    },

    showRerun() {
        if (!this.visible) return;
        const { shell, data } = this.ctx;
        shell.rerun.show({
            text: data.summary() ? 'Assumptions changed — results need a re-run' : 'Assumptions changed',
            actionLabel: data.summary() ? 'Apply & re-run' : 'Save',
            onRun: () => this.apply(),
            // "Not now" only puts the bar away: the edits stay staged, and the bars in the
            // Assumptions and spots cards still offer Apply and Discard.
            onDismiss: () => this.refocus(),
        });
    },

    apply() {
        const { store, ui, data } = this.ctx;
        const next = this.staged();
        store.update('settings', s => ({ ...s, finance: next.finance, vatReturns: next.vatReturns, maxPaybackYears: next.maxPaybackYears, spots: next.spots }));
        this.sync();
        this.ctx.shell.rerun.hide();
        this.renderAssumptions();
        this.renderSpots();
        this.renderPrices();
        this.refocus();
        ui.toast(data.summary() ? 'Saved. Every result is re-running with your assumptions.' : 'Saved. They’ll be used once your data is loaded.', { tone: 'good' });
    },

    discard() {
        this.sync();
        this.ctx.shell.rerun.hide();
        this.renderAssumptions();
        this.renderSpots();
        this.renderPrices();
        this.refocus();
    },

    /**
     * After Apply / Discard / Not now the pressed button has gone (re-rendered or hidden), so put
     * keyboard focus back on the field last edited — or the Assumptions heading.
     */
    refocus() {
        requestAnimationFrame(() => {
            const a = document.activeElement;
            if (a && a !== document.body && a.isConnected && !a.closest('#rerun-bar, [hidden]')) return;
            const holder = this.lastFk && this.el.querySelector(`[data-fk="${this.lastFk}"]`);
            const target = holder ? controlIn(holder) : null;
            if (target) { target.focus({ preventScroll: false }); return; }
            const h = this.el.querySelector('#mv-h-assumptions');
            if (h) { h.tabIndex = -1; h.focus(); }
        });
    },

    /**
     * Re-render a section without losing keyboard focus: the control whose [data-fk] matches the
     * one focused before (or `focus`, a selector for a deliberate new target) gets it back.
     */
    keepFocus(host, build, focus = null) {
        const a = document.activeElement;
        const fk = a && host.contains(a) ? a.closest('[data-fk]')?.dataset.fk : null;
        build();
        const holder = (focus && host.querySelector(focus)) || (fk && host.querySelector(`[data-fk="${fk}"]`));
        controlIn(holder)?.focus({ preventScroll: true });
    },

    paintStaged(d) {
        for (const host of this.el.querySelectorAll('[data-staged]')) host.hidden = !d;
    },

    stagedBar() {
        const { ui } = this.ctx;
        const bar = ui.h('div', { class: 'mv-staged', role: 'status', dataset: { staged: '' }, hidden: !this.dirty() },
            ui.h('span', null, 'You have unsaved changes.'),
            ui.h('div', { class: 'mv-staged-acts' },
                ui.button({ label: 'Discard', kind: 'ghost', size: 'sm', onClick: () => this.discard() }),
                ui.button({ label: this.ctx.data.summary() ? 'Apply & re-run' : 'Save', kind: 'primary', size: 'sm', onClick: () => this.apply() })));
        return bar;
    },

    /* ── layout ───────────────────────────────────────────────────────────── */

    render() {
        const { ui } = this.ctx;
        this.hosts = {};
        const toc = ui.h('nav', { class: 'mv-toc', 'aria-label': 'On this page' },
            ui.h('p', { class: 'mv-toc-t' }, 'On this page'),
            ui.h('ol', null, SECTIONS.map(s => ui.h('li', null, ui.h('a', {
                href: `#method?s=${s.id}`, dataset: { to: s.id },
                on: { click: e => { e.preventDefault(); this.jump(s.id); } },
            }, ui.h('span', null, s.n), ui.h('span', null, s.title))))));
        const jump = ui.h('div', { class: 'mv-jump' }, ui.select({
            ariaLabel: 'Jump to a section', value: '',
            options: [{ value: '', label: 'Jump to a section…' }].concat(SECTIONS.map(s => ({ value: s.id, label: `${s.n} · ${s.title}` }))),
            onChange: v => { if (v) this.jump(v); },
        }));
        const main = ui.h('div', { class: 'mv-main' }, SECTIONS.map(s => {
            const body = ui.h('div', { class: 'mv-sec-body' });
            this.hosts[s.id] = body;
            return ui.h('section', { class: 'mv-sec', dataset: { sec: s.id }, 'aria-labelledby': `mv-h-${s.id}` },
                ui.h('header', { class: 'mv-sec-head' },
                    ui.h('span', { class: 'mv-sec-n', 'aria-hidden': 'true' }, s.n),
                    ui.h('h2', { id: `mv-h-${s.id}` }, s.title),
                    ui.h('p', null, s.lede)),
                body);
        }));
        this.el.replaceChildren(
            ui.h('div', { class: 'view-head' }, ui.h('div', null,
                ui.h('div', { class: 'view-kicker' }, 'Method'),
                ui.h('h1', { class: 'view-title' }, 'How the calculator works'),
                ui.h('p', { class: 'view-lede' }, 'The physics, the prices, the rules and the assumptions behind every figure — and the places where the model is guessing.')),
            ui.button({ label: 'Save as PDF', icon: 'print', kind: 'ghost', onClick: () => window.print() })),
            jump,
            ui.h('div', { class: 'mv-layout' }, toc, main));
        this.renderHow();
        this.renderSources();
        this.renderPrices();
        this.renderRules();
        this.renderAssumptions();
        this.renderSpots();
        this.renderLimits();
        this.renderExport();
        this.renderReset();
        this.watchToc(toc);
    },

    jump(id) {
        const sec = this.el.querySelector(`[data-sec="${id}"]`);
        if (!sec) return;
        sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        try { history.replaceState(null, '', `#method?s=${id}`); } catch { /* sandboxed: keep the old hash */ }
        this.params = { s: id };
        const h = sec.querySelector('h2');
        if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
    },

    watchToc(toc) {
        this.io?.disconnect();
        const links = new Map([...toc.querySelectorAll('a')].map(a => [a.dataset.to, a]));
        const secs = [...this.el.querySelectorAll('.mv-sec')];
        let raf = 0;
        // The current section is the last one whose heading has scrolled past the sticky bars; at
        // the very bottom, the last one that is at least half on screen (short final sections).
        const pick = () => {
            raf = 0;
            if (this.el.hidden || !secs.length) return;
            let cur = secs[0].dataset.sec;
            for (const s of secs) if (s.getBoundingClientRect().top <= 150) cur = s.dataset.sec;
            const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
            if (atBottom) for (const s of secs) if (s.getBoundingClientRect().top < window.innerHeight * 0.55) cur = s.dataset.sec;
            for (const [id, a] of links) a.setAttribute('aria-current', String(id === cur));
        };
        const onScroll = () => { if (!raf) raf = requestAnimationFrame(pick); };
        window.addEventListener('scroll', onScroll, { passive: true });
        this.io = { disconnect: () => window.removeEventListener('scroll', onScroll) };
        pick();
    },

    /* ── 01 how it works ──────────────────────────────────────────────────── */

    renderHow() {
        const { ui } = this.ctx;
        const items = [];
        let lane = null;
        CHAIN.forEach((c, i) => {
            if (c.lane !== lane) { lane = c.lane; items.push(ui.h('li', { class: 'mv-lane', 'aria-hidden': 'true' }, lane)); }
            const last = i === CHAIN.length - 1 || CHAIN[i + 1].lane !== c.lane;
            items.push(ui.h('li', { class: ['mv-node', c.key && 'is-key', last && 'is-last'] },
                ui.h('span', { class: 'mv-node-n', 'aria-hidden': 'true' }, c.n),
                ui.h('span', { class: 'mv-node-t' }, c.t),
                ui.h('span', { class: 'mv-node-d' }, c.d),
                ui.h('span', { class: 'mv-node-m' }, c.m)));
        });
        this.hosts.how.replaceChildren(ui.h('div', { class: 'stack' },
            ui.card({ body: ui.h('ol', { class: 'mv-chain', 'aria-label': 'From meter reading to payback, step by step' }, items) }),
            ui.h('div', { class: 'tiles' },
                ui.statTile({ label: 'One half-hour', value: '±20–27%', sub: 'Satellite sunshine for any single half-hour' }),
                ui.statTile({ label: 'A whole year', value: '±1–2%', sub: 'Bias in annual output from the satellite data' }),
                ui.statTile({ label: 'Year to year', value: '−5…+7%', sub: 'London sunshine, 2006–2025, vs the average' })),
            ui.h('p', { class: 'mv-prose' }, 'The chain was checked against reference implementations: sun position against NREL SPA (within 0.01°), sky and panel models against pvlib (to 10⁻⁶ W/m²), and annual output against PVGIS (within about 0.7%). The headline uses a ',
                ui.h('b', null, 'typical year'), ' — your usage and prices from the last 12 months, with each month’s sunshine scaled to its 2006–2025 average at your home — and shows the last 12 months as they actually happened alongside it.')));
    },

    /* ── 02 sources ───────────────────────────────────────────────────────── */

    renderSources() {
        const { ui } = this.ctx;
        const link = (text, href) => ui.h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
        const rows = [
            { s: link('Octopus Energy API', 'https://developer.octopus.energy/'), use: 'Your half-hourly usage, account and tariffs; Agile, Flexible and export prices.', lic: 'Your own account data, read with your key. Not affiliated with or endorsed by Octopus Energy.' },
            { s: link('Open-Meteo', 'https://open-meteo.com/'), use: 'The weather API every sunshine, temperature and wind figure comes through.', lic: ['Weather data by Open-Meteo.com, ', link('CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'), '.'] },
            { s: 'EUMETSAT CM SAF SARAH-3', use: '30-minute satellite irradiance, and the 2006–2025 averages.', lic: ['© EUMETSAT, ', link('doi:10.5676/EUM_SAF_CM/SARAH/V003', 'https://doi.org/10.5676/EUM_SAF_CM/SARAH/V003'), '.'] },
            { s: 'EUMETSAT LSA SAF (MSG)', use: '15-minute satellite irradiance for the newest days.', lic: '© EUMETSAT LSA SAF.' },
            { s: 'ECMWF IFS', use: 'Air temperature and wind; last-resort irradiance (×0.93).', lic: 'ECMWF open data via Open-Meteo, CC BY 4.0.' },
            { s: link('postcodes.io', 'https://postcodes.io/'), use: 'Postcode → map position; map pin → postcode.', lic: 'Contains OS data © Crown copyright and database right; Royal Mail data © Royal Mail copyright and database right; ONS data. Open Government Licence v3.0.' },
            { s: 'Esri World Imagery · OpenStreetMap', use: 'Map tiles for placing your home and pointing panels.', lic: ['Imagery © Esri, Maxar, Earthstar Geographics. Map © OpenStreetMap contributors, ', link('ODbL', 'https://www.openstreetmap.org/copyright'), '.'] },
            { s: link('Leaflet', 'https://leafletjs.com/'), use: 'The map library.', lic: 'BSD 2-Clause.' },
            { s: 'Retailer pages', use: 'Kit, battery and power-station prices and specifications.', lic: 'Checked 3–5 Oct 2026 — see Limitations for each item’s date.' },
            { s: link('ENA register', 'https://myplugin.solar/'), use: 'Which plug-in kits are approved (ENA references in the catalog).', lic: 'Energy Networks Association.' },
        ];
        this.hosts.sources.replaceChildren(ui.card({
            body: ui.table({
                caption: 'Data sources and licences', dense: false,
                columns: [
                    { key: 's', label: 'Source', sortable: false, mobile: 'title', width: '24%' },
                    { key: 'use', label: 'Used for', sortable: false },
                    { key: 'lic', label: 'Licence and attribution', sortable: false },
                ],
                rows: rows.map(r => ({ ...r, lic: ui.h('span', null, r.lic) })),
            }),
        }));
    },

    /* ── 03 prices, VAT, levy ─────────────────────────────────────────────── */

    renderPrices() {
        const { ui, data, fmt } = this.ctx;
        const host = this.hosts?.prices;
        if (!host) return;
        const s = data.summary();
        const flatP = this.ctx.store.get().connection.flatP;
        const basisNames = {
            mine: 'your own tariffs', agile: 'Agile Octopus (the version on sale now)', flexible: 'Flexible Octopus',
            flat: Number.isFinite(flatP) ? `a flat ${fmt.p(flatP)} per kWh before VAT` : 'a flat price',
        };
        const basis = s && s.source !== 'demo' ? basisNames[s.priceBasis] || s.priceBasis : null;
        const billed = ui.card({
            className: 'mv-basis', body: [
                ui.h('div', { class: 'mv-tag' }, 'Last 12 months'),
                ui.h('h3', null, 'As you were billed'),
                ui.h('ul', null,
                    ui.h('li', null, 'Each half-hour at the price you actually paid on your own tariffs — or on the tariff you chose on the data page.'),
                    ui.h('li', null, 'VAT as it was charged at the time: 5% until 30 Sep 2026.'),
                    ui.h('li', null, 'Export at the rate paid then (Outgoing was 15p until 1 Mar 2026, then 12p).'),
                    ui.h('li', null, 'Shown as “last 12 months as it happened”.')),
            ],
        });
        const fwd = ui.card({
            className: 'mv-basis', accent: true, body: [
                ui.h('div', { class: 'mv-tag' }, 'Year 1 onwards — the headline'),
                ui.h('h3', null, 'At today’s prices'),
                ui.h('ul', null,
                    ui.h('li', null, 'The same half-hours, with Agile prices before 1 Apr 2026 lowered by 3.33p (3.5p with VAT): the government levy removed that day.'),
                    ui.h('li', null, 'Fixed and flat tariffs at today’s rate for every half-hour.'),
                    ui.h('li', null, 'VAT month by month: 0% until 31 Mar 2027, then 5% (see Assumptions).'),
                    ui.h('li', null, 'Export at today’s rates: Outgoing 12p; Prime 16p 4–7pm and 9p otherwise; never VAT’d.'),
                    ui.h('li', null, 'Batteries plan on these prices with 5% VAT added, so they don’t chase a levy that no longer exists.')),
            ],
        });
        // The other bases you could switch to (never the one already in use).
        const others = ['agile', 'flexible', 'flat'].filter(b => b !== s?.priceBasis)
            .map(b => ({ agile: 'Agile today', flexible: 'Flexible', flat: 'a flat rate' })[b]);
        const otherText = `${others.slice(0, -1).join(', ')} or ${others[others.length - 1]}`;
        const basisLine = s?.source === 'demo'
            ? ui.h('p', { class: 'mv-prose' }, 'The example uses ', ui.h('b', null, 'real Agile prices for London'), '. With your own data you can price your usage as if you were on Agile today, Flexible or a flat rate, from ', ui.h('a', { href: '#data' }, 'the data page'), '.')
            : s
                ? ui.h('p', { class: 'mv-prose' }, 'Your usage is priced on ', ui.h('b', null, basis), `. To price it as if you were on ${otherText}, `,
                    ui.h('a', { href: '#data?edit=prices' }, 'change it on the data page'), '.')
                : ui.h('p', { class: 'mv-prose' }, 'Octopus customers are priced on their own tariffs by default; a CSV or a usage profile is priced on Agile. You can switch to Agile today, Flexible or a flat rate on ',
                    ui.h('a', { href: '#data' }, 'the data page'), '.');
        host.replaceChildren(ui.h('div', { class: 'stack' },
            ui.h('div', { class: 'mv-two' }, billed, fwd),
            ui.card({ title: 'VAT on electricity', level: 3, subtitle: 'Domestic electricity VAT, month by month', body: this.vatStrip(s) }),
            basisLine,
            ui.h('p', { class: 'mv-prose' }, 'Solar panels and batteries supplied and fitted by an installer are 0% VAT until 31 Mar 2027 (energy-saving materials relief). Kits you buy yourself include 20% VAT, and every catalog price is a retail price including it.'),
            s && s.source === 'octopus' && s.tariffCode ? ui.h('p', { class: 'mv-prose' }, `Latest tariff on your account: ${s.tariffCode} (region ${s.region}, ${fmt.date(Date.parse(`${s.to}T12:00:00Z`))}).`) : null));
    },

    /** Months from Oct 2025: the VAT rate as segments, with the data year and year 1 bracketed below. */
    vatStrip(summary) {
        const { ui } = this.ctx;
        const start = monthIndex('2025-10');
        const vatReturns = this.stage?.vatReturns !== false;
        const install = this.stage?.finance?.installDate || DEFAULT_FINANCE.installDate;
        const y1 = monthIndex(install);
        const end = Math.max(monthIndex('2027-12'), y1 + 12);
        const months = end - start;
        const col = idx => Math.min(months, Math.max(0, idx - start)) + 1;
        const seg = (from, to, rate, label) => ui.h('div', { class: ['mv-vat-seg', rate ? 'is-5' : 'is-0'], style: { gridColumn: `${col(from)} / ${col(to)}`, gridRow: '1' }, title: label }, label);
        const vatOff = monthIndex('2026-10'), vatOn = monthIndex('2027-04');
        const segs = [seg(start, vatOff, 5, '5%'), seg(vatOff, vatOn, 0, '0%'), seg(vatOn, end, vatReturns ? 5 : 0, vatReturns ? '5%' : '0% (if extended)')];
        const dFrom = summary?.from ? monthIndex(summary.from) : monthIndex('2025-10');
        const dTo = summary?.to ? monthIndex(summary.to) + 1 : monthIndex('2026-10');
        const brackets = [
            ui.h('div', { class: 'mv-vat-br', style: { gridColumn: `${col(dFrom)} / ${col(dTo)}`, gridRow: '2' } }, summary ? 'Your data year' : 'The latest 12 months'),
            ui.h('div', { class: ['mv-vat-br', 'is-y1'], style: { gridColumn: `${col(y1)} / ${col(y1 + 12)}`, gridRow: '3' } }, `Year 1 · ${monthName(y1)}`),
        ];
        const ticks = [];
        for (let i = start; i < end; i++) {
            const m = i % 12;
            ticks.push(ui.h('span', { style: { gridColumn: `${i - start + 1}` } }, m === 0 ? String(Math.floor(i / 12)) : m === 3 || m === 6 || m === 9 ? MONTHS[m] : ''));
        }
        const covers = summary ? `Your data covers ${monthName(dFrom)} to ${monthName(dTo - 1)}` : `Your data will be the latest 12 months, about ${monthName(dFrom)} to ${monthName(dTo - 1)}`;
        const desc = `VAT on electricity: 5% until 30 Sep 2026, 0% from 1 Oct 2026 to 31 Mar 2027, then ${vatReturns ? '5%' : '0% if the relief is extended'}. ${covers}; year 1 runs from ${monthName(y1)} to ${monthName(y1 + 11)}.`;
        return ui.h('div', { class: 'mv-vat' },
            ui.h('div', { class: 'mv-vat-grid', style: { '--months': months }, role: 'img', 'aria-label': desc }, segs, brackets),
            ui.h('div', { class: 'mv-vat-ticks', style: { '--months': months }, 'aria-hidden': 'true' }, ticks),
            ui.h('p', { class: 'field-hint', style: { marginTop: '10px' } }, desc));
    },

    /* ── 04 rules ─────────────────────────────────────────────────────────── */

    renderRules() {
        const { ui } = this.ctx;
        const timeline = ui.h('ol', { class: 'mv-rules' }, RULES.map(r => ui.h('li', { class: ['mv-rule', r.now && 'is-now'] },
            ui.h('div', { class: 'mv-rule-date' }, r.date),
            ui.h('div', { class: 'mv-rule-dot', 'aria-hidden': 'true' }),
            ui.h('div', { class: 'mv-rule-body' },
                ui.h('div', { class: 'mv-rule-t' }, r.t),
                ui.h('div', { class: 'mv-rule-d' }, r.d),
                ui.h('div', { class: 'mv-rule-l' }, r.links.map(([t, href]) => ui.h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, t, ui.icon('external', { size: 13 }))))))));
        const routes = ui.h('div', { class: 'mv-routes' }, ROUTES.map(r => ui.h('div', { class: ['mv-route', r.tone === 'whatif' && 'is-whatif'] },
            ui.h('div', { class: 'mv-route-t' }, ui.badge({ text: r.badge, tone: r.tone }), r.name),
            ui.h('ul', null, r.items.map(i => ui.h('li', null, i))))));
        this.hosts.rules.replaceChildren(ui.h('div', { class: 'stack' },
            ui.card({ body: timeline }),
            ui.h('h3', { class: 'card-title' }, 'What each route means'),
            routes,
            ui.h('p', { class: 'mv-prose' }, 'Sources were read on 5 Oct 2026. Rules change — check the links before you buy. This page is a summary, not legal advice.')));
    },

    /* ── 05 assumptions ───────────────────────────────────────────────────── */

    renderAssumptions() {
        const { ui, fmt } = this.ctx;
        const host = this.hosts?.assumptions;
        if (!host) return;
        const st = this.stage;
        const nextMonth = firstOfNextMonth();
        const valueOf = f => (f.settings ? st[f.key] : st.finance[f.key] ?? DEFAULT_FINANCE[f.key]);
        const defOf = f => (f.settings ? (f.key === 'vatReturns' ? true : f.def) : DEFAULT_FINANCE[f.key]);
        const showDef = f => {
            const d = defOf(f);
            if (f.kind === 'toggle') return d ? 'on' : 'off';
            if (f.kind === 'month') return fmt.month(d);
            if (f.unit === '£') return fmt.gbp(d);
            const v = f.scale ? d * f.scale : d;
            return `${plain(v)}${f.unit ? (f.unit.startsWith('%') ? f.unit : ` ${f.unit}`) : ''}`;
        };
        const setVal = (f, v) => {
            if (f.settings) st[f.key] = v;
            else st.finance[f.key] = v;
            this.lastFk = `fin-${f.key}`;
            wraps.get(f.key)?.classList.toggle('is-changed', !same(v, defOf(f)));
            this.changed();
            if (f.key === 'installDate' || f.key === 'vatReturns') this.renderPrices();
        };
        const sr = () => ui.h('span', { class: 'mv-sr' }, ' (changed from the default)');
        const wraps = new Map();
        const groups = FIN_GROUPS.map(g => ui.h('div', null,
            ui.h('div', { class: 'mv-group-t' }, g.title),
            ui.h('div', { class: 'mv-fields' }, g.fields.map(f => {
                const v = valueOf(f);
                let input;
                if (f.kind === 'toggle') {
                    input = ui.toggle({ label: ui.h('span', { class: 'mv-tlabel' }, f.label, sr()), checked: !!v, hint: f.hint, onChange: c => setVal(f, c) });
                    const w = ui.h('div', { class: ['mv-field', !same(v, defOf(f)) && 'is-changed'], dataset: { fk: `fin-${f.key}` } }, input);
                    wraps.set(f.key, w);
                    return w;
                }
                if (f.kind === 'month') {
                    const opts = [];
                    const first = Math.min(monthIndex(nextMonth), monthIndex(v || nextMonth));
                    for (let i = first; i < monthIndex(nextMonth) + 18; i++) {
                        const iso = `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;
                        opts.push({ value: iso, label: `1 ${monthName(i)}${iso < nextMonth ? ' (in the past)' : ''}` });
                    }
                    input = ui.select({ value: v, options: opts, onChange: x => setVal(f, x) });
                } else {
                    const shown = f.scale ? +(v * f.scale).toFixed(4) : v;
                    input = ui.numberInput({
                        value: shown, min: f.min, max: f.max, step: f.step, unit: f.unit || undefined,
                        onChange: x => setVal(f, x == null ? defOf(f) : f.scale ? +(x / f.scale).toFixed(6) : x),
                    });
                }
                const past = f.kind === 'month' && v < nextMonth;
                const w = ui.h('div', { class: ['mv-field', !same(v, defOf(f)) && 'is-changed'], dataset: { fk: `fin-${f.key}` } },
                    ui.field({ label: [f.label, sr()], input, hint: [f.hint, ' Default ', ui.h('b', null, showDef(f)), '.', past ? ui.h('span', { class: 'hint-warn' }, ' This is in the past — year 1 should start next month.') : null] }));
                wraps.set(f.key, w);
                return w;
            }))));
        const reset = ui.button({
            label: 'Restore all defaults', kind: 'ghost', size: 'sm', icon: 'refresh',
            onClick: () => {
                this.stage.finance = {};
                this.stage.vatReturns = true;
                this.stage.maxPaybackYears = 10;
                this.renderAssumptions();
                this.renderPrices();
                this.changed();
            },
        });
        reset.dataset.fk = 'fin-reset';
        this.keepFocus(host, () => host.replaceChildren(ui.card({
            title: 'Money assumptions', level: 3, subtitle: 'Changed values are marked •. Nothing applies until you press Apply.',
            actions: reset,
            body: ui.h('div', { class: 'mv-form' }, groups, this.stagedBar()),
        })));
    },

    /* ── 06 spots ─────────────────────────────────────────────────────────── */

    renderSpots({ focus = null } = {}) {
        const { ui, store, data } = this.ctx;
        const host = this.hosts?.spots;
        if (!host) return;
        const spots = this.stage.spots;
        const usingDefaults = !(store.get().settings.spots || []).length;
        const summary = data.summary();
        const cards = spots.map((sp, i) => this.spotCard(sp, i, summary));
        const add = ui.h('button', {
            type: 'button', class: 'mv-spot-add', disabled: spots.length >= MAX_SPOTS, dataset: { fk: 'spot-add' },
            on: {
                click: () => {
                    if (this.stage.spots.length >= MAX_SPOTS) return;
                    const n = this.stage.spots.length;
                    this.stage.spots.push({ id: `spot-${Date.now().toString(36)}`, name: `Spot ${n + 1}`, kind: 'ground', azimuth: null, tilt: null, tiltRange: [15, 45], maxPanels: 2, shadingPct: 3, horizon: [], groundLevel: true });
                    this.lastFk = `s${n}-name`;
                    this.renderSpots({ focus: `[data-fk="s${n}-name"]` });
                    this.changed();
                },
            },
        }, spots.length >= MAX_SPOTS ? 'Up to four spots' : '+ Add a spot');
        const useDefaults = usingDefaults ? null : ui.button({
            label: 'Use our defaults', kind: 'ghost', size: 'sm',
            onClick: () => { this.stage.spots = clone(DEFAULT_SPOTS); this.renderSpots({ focus: '[data-fk="s0-name"]' }); this.changed(); },
        });
        this.keepFocus(host, () => host.replaceChildren(ui.h('div', { class: 'stack' },
            ui.h('p', { class: 'mv-prose' }, usingDefaults
                ? ['We assumed ', ui.h('b', null, 'a ground or flat-roof frame (any direction, 15–45°)'), ' and ', ui.h('b', null, 'a west-facing wall'), '. If your home only has, say, a south-facing balcony, change these — the verdict will only suggest what fits.']
                : 'Your spots. Each option goes on the best one it fits; a spot with a fixed direction is used as-is.'),
            ui.h('div', { class: 'mv-spots' }, cards, add),
            useDefaults ? ui.h('div', { class: 'row' }, useDefaults) : null,
            this.stagedBar())), focus);
    },

    spotCard(sp, i, summary) {
        const { ui, fmt } = this.ctx;
        const kind = SPOT_KINDS.find(k => k.value === sp.kind) || SPOT_KINDS[0];
        const fk = name => `s${i}-${name}`;
        const tag = (el, name) => { el.dataset.fk = fk(name); return el; };
        const edit = (fn, name) => { fn(sp); if (name) this.lastFk = fk(name); this.changed(); };
        const name = tag(ui.textInput({ value: sp.name, maxLength: MAX_SPOT_NAME, ariaLabel: `Name of spot ${i + 1}`, onInput: v => edit(s => { s.name = v.slice(0, MAX_SPOT_NAME) || `Spot ${i + 1}`; }, 'name') }), 'name');
        const kindSel = tag(ui.select({
            value: sp.kind, options: SPOT_KINDS.map(k => ({ value: k.value, label: k.label })),
            onChange: v => {
                const k = SPOT_KINDS.find(x => x.value === v);
                edit(s => {
                    s.kind = v;
                    s.groundLevel = v === 'ground' || v === 'wall';
                    if (k.any) { s.azimuth = null; s.tilt = null; s.tiltRange = [...k.range]; }
                    else {
                        s.azimuth = finite(s.azimuth) ? s.azimuth : v === 'wall' ? 270 : 180;
                        if (k.fixedTilt != null) { s.tilt = k.fixedTilt; s.tiltRange = [k.fixedTilt, k.fixedTilt]; } else { s.tilt = null; s.tiltRange = [...k.range]; }
                    }
                }, 'kind');
                this.renderSpots();
            },
        }), 'kind');
        if (!kind.any && !finite(sp.azimuth)) sp.azimuth = sp.kind === 'wall' ? 270 : 180;
        const anyDir = kind.any && sp.azimuth == null;
        const dirSeg = tag(ui.segmented({
            size: 'sm', ariaLabel: 'Direction', value: anyDir ? 'any' : 'fixed',
            options: [{ value: 'any', label: 'I can choose' }, { value: 'fixed', label: 'Fixed' }],
            onChange: v => { edit(s => { s.azimuth = v === 'any' ? null : 180; }, 'dir'); this.renderSpots(); },
        }), 'dir');
        let dirBody;
        if (anyDir) {
            dirBody = ui.h('div', { class: 'mv-spot-any' }, ui.icon('sun'), ui.h('span', null, 'We’ll point it at the best direction for your prices and usage.'));
        } else {
            const compass = tag(ui.compassInput({ azimuth: sp.azimuth, size: 200, label: `Spot ${i + 1} faces`, onChange: az => edit(s => { s.azimuth = az; }, 'az') }), 'az');
            const mapBtn = summary && finite(summary.lat) ? tag(ui.button({
                label: 'Point it on the map', size: 'sm', kind: 'ghost',
                onClick: () => this.mapPicker(sp, az => { compass.setValue(az); edit(s => { s.azimuth = az; }, 'az'); }),
            }), 'map') : null;
            dirBody = ui.h('div', { class: 'mv-spot-dir' }, compass, ui.h('div', { class: 'stack-sm' },
                ui.h('p', { class: 'field-hint' }, 'Drag the needle, click the dial, or use the arrow keys. 180° is due south.'), mapBtn));
        }
        const num = (name, o) => tag(ui.numberInput(o), name);
        const fixedTilt = kind.fixedTilt != null || (sp.tilt != null);
        const tiltFields = fixedTilt
            ? [ui.field({ label: 'Tilt', input: num('tilt', { value: sp.tilt ?? kind.fixedTilt ?? 35, min: 0, max: 90, step: 1, unit: '°', onChange: v => edit(s => { s.tilt = v ?? 35; s.tiltRange = [s.tilt, s.tilt]; }, 'tilt') }) })]
            : [ui.field({ label: 'Tilt from', input: num('tilt0', { value: sp.tiltRange?.[0] ?? 15, min: 0, max: 90, step: 5, unit: '°', onChange: v => edit(s => { s.tiltRange = [Math.min(v ?? 15, s.tiltRange?.[1] ?? 90), s.tiltRange?.[1] ?? 45]; }, 'tilt0') }) }),
                ui.field({ label: 'Tilt up to', input: num('tilt1', { value: sp.tiltRange?.[1] ?? 45, min: 0, max: 90, step: 5, unit: '°', onChange: v => edit(s => { s.tiltRange = [s.tiltRange?.[0] ?? 15, Math.max(v ?? 45, s.tiltRange?.[0] ?? 0)]; }, 'tilt1') }) })];
        const remove = tag(ui.button({
            label: 'Remove', size: 'sm', kind: 'ghost', ariaLabel: `Remove spot ${i + 1}, ${sp.name}`,
            onClick: () => {
                this.stage.spots.splice(i, 1);
                if (!this.stage.spots.length) this.stage.spots = clone(DEFAULT_SPOTS);
                // Focus moves to the spot that took this one's place, else the one before, else Add.
                const next = Math.min(i, this.stage.spots.length - 1);
                this.lastFk = null;
                this.renderSpots({ focus: next >= 0 ? `[data-fk="s${next}-remove"]` : '[data-fk="spot-add"]' });
                this.changed();
            },
        }), 'remove');
        const headId = ui.uniqueId('mv-spot');
        return ui.h('div', { class: 'mv-spot', role: 'group', 'aria-labelledby': headId },
            ui.h('div', { class: 'mv-spot-head' }, ui.h('span', { class: 'mv-spot-n', id: headId }, `Spot ${i + 1}${anyDir ? '' : ` · ${fmt.compass(sp.azimuth)}`}`), remove),
            ui.field({ label: 'Name', input: name, hint: `Up to ${MAX_SPOT_NAME} characters.` }),
            ui.field({ label: 'Kind', input: kindSel }),
            kind.any ? ui.field({ label: 'Direction', input: dirSeg }) : ui.h('div', { class: 'field-label' }, 'Direction it faces'),
            dirBody,
            ui.h('div', { class: 'mv-spot-3' },
                ...tiltFields,
                ui.field({ label: 'Max panels', input: num('max', { value: sp.maxPanels ?? 2, min: 1, max: 8, step: 1, onChange: v => edit(s => { s.maxPanels = v ?? 2; }, 'max') }) }),
                ui.field({ label: 'Shading', input: num('shade', { value: sp.shadingPct ?? 3, min: 0, max: 60, step: 1, unit: '%', onChange: v => edit(s => { s.shadingPct = v ?? 3; }, 'shade') }) })),
            tag(ui.toggle({ label: 'At ground level', hint: 'Anything higher needs a professional’s advice for plug-in kits.', checked: sp.groundLevel !== false, onChange: v => edit(s => { s.groundLevel = v; }, 'ground') }), 'ground'));
    },

    async mapPicker(sp, onPick) {
        const { ui, data } = this.ctx;
        const s = data.summary();
        if (!s) return;
        const host = ui.h('div', { class: 'map-box', style: { height: '360px' } });
        let az = finite(sp.azimuth) ? sp.azimuth : 180;
        const label = sp.name.length > 40 ? `${sp.name.slice(0, 39).trimEnd()}…` : sp.name;
        const dlg = ui.modal({
            title: `Which way does “${label}” face?`, wide: true,
            body: [ui.h('p', { class: 'field-hint', style: { marginBottom: '10px' } }, 'Drag the white handle round your home. The gold line is the direction the panels face.'), host],
            actions: [{ label: 'Cancel' }, { label: 'Use this direction', primary: true, onClick: () => onPick(az) }],
            onClose: () => { this.picker?.destroy?.(); this.picker = null; },
        });
        try {
            const { createAzimuthPicker } = await import('../map.js');
            this.picker = await createAzimuthPicker(host, { lat: s.lat, lon: s.lon, azimuth: az, onChange: a => { az = a; } });
        } catch (err) {
            ui.toast(err?.message || 'Couldn’t load the map.', { tone: 'warn' });
            dlg.close();
        }
    },

    /* ── 07 limitations ───────────────────────────────────────────────────── */

    renderLimits() {
        const { ui } = this.ctx;
        const list = ui.h('ul', { class: 'mv-limits' }, LIMITS.map(l => ui.h('li', { class: 'mv-limit' },
            ui.h('div', { class: 'mv-limit-t' }, l.t),
            ui.h('div', { class: 'mv-limit-d' }, l.d),
            l.m ? ui.h('div', { class: 'mv-limit-m' }, l.m) : null)));
        const catHost = ui.h('div', null, ui.skeleton({ lines: 4 }));
        const cat = ui.details({
            summary: 'Every catalog price, and when it was checked',
            body: catHost,
            onToggle: open => { if (open && !catHost.dataset.done) this.loadCatalog(catHost); },
        });
        this.hosts.limits.replaceChildren(ui.card({ body: [list, cat] }));
    },

    async loadCatalog(host) {
        const { ui, fmt } = this.ctx;
        host.dataset.done = '1';
        try {
            const get = async n => { const r = await fetch(new URL(`../../data/${n}.json`, import.meta.url)); if (!r.ok) throw new Error(`data/${n}.json: ${r.status}`); return r.json(); };
            const [kits, stations, bundles] = await Promise.all(['kits', 'stations', 'bundles'].map(get));
            const kindLabel = k => ({ microinverter: 'Plug-in kit', 'battery-inverter': 'Battery + inverter', 'battery-addon': 'Battery', panel: 'Panels', mount: 'Mounting' }[k] || k);
            // Catalog brands and models carry notes in brackets ("City Plumbing (DMEGC panel + …)"); show the name only.
            const name = x => `${x.brand ? `${String(x.brand).split(' (')[0]} ` : ''}${String(x.model || x.name || x.id).split(' (')[0]}`;
            // A micro-inverter sold for an electrician to wire in: a whole kit when it comes with panels.
            const wiredKind = x => (/panel|kit/i.test(String(x.model || '')) ? 'Kit (electrician)' : 'Inverter (electrician)');
            const host_ = u => { try { return new URL(String(u).split(' ')[0]).hostname.replace(/^www\./, ''); } catch { return ''; } };
            const src = u => { const hst = host_(u); return hst ? ui.h('a', { href: String(u).split(' ')[0], target: '_blank', rel: 'noopener noreferrer' }, hst) : '—'; };
            const rows = [
                ...(kits.kits || []).map(x => ({ name: name(x), kind: /hardwired/.test(x.installRoute || '') && x.kind === 'microinverter' ? wiredKind(x) : kindLabel(x.kind), price: x.priceGbp, date: x.priceDate, src: x.priceSource })),
                ...(stations.stations || []).map(x => ({ name: name(x), kind: 'Power station', price: x.priceGbp, date: x.priceDate, src: x.priceSource })),
                ...(bundles.bundles || []).map(x => ({ name: x.name, kind: 'Bundle', price: x.priceGbp, date: x.priceDate, src: x.priceSource })),
            ];
            host.replaceChildren(ui.table({
                caption: 'Catalog prices with the date each was checked', dense: true,
                columns: [
                    { key: 'name', label: 'Item', mobile: 'title' },
                    { key: 'kind', label: 'Kind' },
                    { key: 'price', label: 'Price', align: 'right', mobile: 'primary', format: v => fmt.gbp(v, { dp: v % 1 ? 2 : 0 }) },
                    { key: 'date', label: 'Checked', align: 'right', format: v => (v ? fmt.date(Date.parse(`${v}T12:00:00Z`)) : '—') },
                    { key: 'src', label: 'Source', sortable: false, format: v => src(v) },
                ],
                rows,
            }));
        } catch (err) {
            host.dataset.done = '';
            host.replaceChildren(ui.h('div', { class: 'notice notice-warn' }, ui.icon('alert'), ui.h('span', null, `Couldn’t load the catalog: ${err?.message || err}`)));
        }
    },

    /* ── 08 export / import ───────────────────────────────────────────────── */

    renderExport() {
        const { ui, data, store } = this.ctx;
        const host = this.hosts?.export;
        if (!host) return;
        const token = (this.exportToken = (this.exportToken || 0) + 1);
        const summary = data.summary();
        const saved = store.get().scenarios.saved || [];
        // The option list needs autoScenarios, a heavy worker job: only ask for it while this view
        // is on screen, so loading data elsewhere doesn't queue it ahead of the verdict.
        this.exportStale = !this.visible;
        const selHost = ui.h('div', { class: 'mv-x-acts' });
        const csvBlock = ui.h('div', { class: 'mv-x' },
            ui.h('div', null,
                ui.h('div', { class: 'mv-x-t' }, 'Half-hourly results (CSV)'),
                ui.h('div', { class: 'mv-x-d' }, 'Every half-hour of the typical year for one option: time, your use, solar, import, export, charge level, price and saving. Opens in any spreadsheet.')),
            selHost);
        let chosen = null;
        const paintCsv = list => {
            if (!summary) {
                selHost.replaceChildren(ui.h('span', { class: 'field-hint' }, 'Load your data first — ', ui.h('a', { href: '#data' }, 'connect'), '.'));
                return;
            }
            const opts = list.map(s => ({ value: s.id, label: s.name || s.id, group: s.group }));
            if (!opts.length) { selHost.replaceChildren(ui.h('span', { class: 'field-hint' }, 'No options to export yet.')); return; }
            chosen = list.find(s => s.id === chosen?.id) || list[0];
            const sel = ui.select({ ariaLabel: 'Option to export', value: chosen.id, options: opts, onChange: v => { chosen = list.find(s => s.id === v); } });
            const btn = ui.button({ label: 'Download CSV', icon: 'table', onClick: () => this.exportCsv(chosen, btn) });
            selHost.replaceChildren(sel, btn);
        };
        const list = saved.map(s => ({ ...s, group: 'Your saved scenarios' }));
        paintCsv(list);
        if (summary && this.visible) {
            selHost.prepend(ui.h('span', { class: 'spinner', 'aria-label': 'Loading options' }));
            data.autoScenarios().then(auto => {
                if (token !== this.exportToken) return;
                paintCsv(list.concat((auto || []).map(s => ({ ...s, group: 'Our options' }))));
            }, err => {
                if (isAbort(err) || token !== this.exportToken) return;
                paintCsv(list);
                if (!list.length) selHost.replaceChildren(ui.h('span', { class: 'field-hint' }, /ENGINE|MODULE|core/i.test(`${err?.code} ${err?.message}`) ? 'The simulation engine isn’t available yet, so there’s nothing to export.' : err?.message || 'Couldn’t list the options.'));
            });
        }

        // Only offer the account number when there is one to include.
        const withAcct = store.get().connection.accountNumber ? ui.checkbox({ label: 'Include my account number' }) : null;
        const jsonBlock = ui.h('div', { class: 'mv-x' },
            ui.h('div', null,
                ui.h('div', { class: 'mv-x-t' }, 'Settings and scenarios (JSON)'),
                ui.h('div', { class: 'mv-x-d' }, 'Your assumptions, mount spots, saved and pinned scenarios, and how you connect. Never your API key.'),
                withAcct ? ui.h('div', { style: { marginTop: '6px' } }, withAcct) : null),
            ui.h('div', { class: 'mv-x-acts' }, ui.button({ label: 'Download JSON', onClick: () => this.exportJson(!!withAcct?.input.checked) })));

        const file = ui.h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Choose a settings file to import' });
        file.addEventListener('change', () => { const f = file.files?.[0]; file.value = ''; if (f) this.importJson(f); });
        const importBlock = ui.h('div', { class: 'mv-x' },
            ui.h('div', null,
                ui.h('div', { class: 'mv-x-t' }, 'Import settings'),
                ui.h('div', { class: 'mv-x-d' }, 'Load a JSON file saved from this page. It replaces your assumptions, spots and scenarios; you’ll see what’s in it first.')),
            ui.h('div', { class: 'mv-x-acts' }, ui.h('label', { class: 'btn mv-file' }, ui.icon('upload'), ui.h('span', null, 'Choose a file…'), file)));

        host.replaceChildren(ui.card({ body: ui.h('div', { class: 'mv-export' }, csvBlock, jsonBlock, importBlock) }));
    },

    async exportCsv(system, btn) {
        const { ui, engine, data } = this.ctx;
        if (!system) return;
        const label = btn.querySelector('span');
        btn.disabled = true;
        label.textContent = 'Preparing…';
        try {
            const { id, name, group, ...rest } = system;
            const csv = await engine.call('exportCsv', { id, name, ...rest });
            const s = data.summary();
            const safe = String(system.id || 'scenario').replace(/[^\w.-]+/g, '-').slice(0, 40);
            download(`solar-${safe}-${s?.from || ''}-${s?.to || ''}.csv`, String(csv ?? ''), 'text/csv;charset=utf-8');
            ui.toast('Downloaded.', { tone: 'good' });
        } catch (err) {
            if (!isAbort(err)) ui.toast(`Couldn’t export: ${err?.message || err}`, { tone: 'bad', timeoutMs: 7000 });
        } finally {
            btn.disabled = false;
            label.textContent = 'Download CSV';
        }
    },

    exportJson(includeAccount) {
        const { store, ui } = this.ctx;
        const st = store.get();
        const c = st.connection;
        const out = {
            app: 'solar-calculator', version: 1, exportedAt: new Date().toISOString(),
            settings: st.settings,
            scenarios: st.scenarios,
            connection: {
                kind: c.kind, location: c.location, demoServerW: c.demoServerW, manual: c.manual,
                installedSolarDate: c.installedSolarDate, priceBasis: c.priceBasis, flatP: c.flatP,
                ...(includeAccount && c.accountNumber ? { accountNumber: c.accountNumber } : {}),
            },
        };
        const text = JSON.stringify(out, null, 2);
        // Belt and braces: the key never lives in state, but make sure no copy of it slips out.
        let key = null;
        try { key = store.getApiKey(); } catch { key = null; }
        if (key && text.includes(key)) { ui.toast('Export stopped: it would have contained your API key.', { tone: 'bad' }); return; }
        download(`solar-calculator-settings-${new Date().toISOString().slice(0, 10)}.json`, text, 'application/json');
        ui.toast('Settings downloaded.', { tone: 'good' });
    },

    async importJson(fileObj) {
        const { ui, store, fmt } = this.ctx;
        let json;
        try {
            if (fileObj.size > 5 * 1024 * 1024) throw new Error('That file is too large to be a settings export.');
            json = JSON.parse(await fileObj.text());
            if (!json || json.app !== 'solar-calculator' || json.version !== 1) throw new Error('That isn’t a settings file from this calculator.');
        } catch (err) {
            ui.toast(err?.message || 'That file couldn’t be read.', { tone: 'bad', timeoutMs: 7000 });
            return;
        }
        // Everything is checked before it is shown or stored: the preview lists what will be used.
        const clean = sanitizeImport(json, { normalizeAccount: ui.normalizeAccount });
        const { settings, scenarios, connection, ignored } = clean;
        const nFin = settings ? Object.keys(settings.finance).length + (settings.vatReturns !== undefined && settings.vatReturns !== true ? 1 : 0) + (settings.maxPaybackYears !== undefined && settings.maxPaybackYears !== 10 ? 1 : 0) : 0;
        const nSpots = settings?.spots?.length ?? 0;
        const nSaved = scenarios?.saved?.length ?? 0;
        const where = connection?.location?.postcode || (Number.isFinite(connection?.location?.lat) ? 'a map pin' : null);
        ui.modal({
            title: 'Import these settings?',
            body: [
                ui.h('p', null, `Saved ${Number.isFinite(Date.parse(json.exportedAt)) ? `on ${fmt.date(Date.parse(json.exportedAt))}` : 'at an unknown time'}. It contains:`),
                ui.h('ul', { style: { margin: '10px 0 0', paddingLeft: '18px', display: 'grid', gap: '4px' } },
                    ui.h('li', null, `${nFin} changed assumption${nFin === 1 ? '' : 's'}`),
                    ui.h('li', null, nSpots ? `${nSpots} mount spot${nSpots === 1 ? '' : 's'}` : 'our default mount spots'),
                    ui.h('li', null, `${nSaved} saved scenario${nSaved === 1 ? '' : 's'}`),
                    connection ? ui.h('li', null, `How you connect${where ? ` (${where})` : ''}`) : null),
                ignored.length ? ui.h('div', { class: 'notice notice-warn', style: { marginTop: '10px' } }, ui.icon('alert'),
                    ui.h('span', null, `${ignored.length} thing${ignored.length === 1 ? '' : 's'} in the file can’t be used and will be left out: `,
                        ignored.slice(0, 6).join('; '), ignored.length > 6 ? `; and ${ignored.length - 6} more` : '', '.')) : null,
                ui.h('p', { style: { marginTop: '10px' } }, 'Your current assumptions, spots and scenarios will be replaced. Your API key isn’t affected.'),
            ],
            actions: [
                { label: 'Cancel' },
                {
                    label: 'Import', primary: true,
                    onClick: () => {
                        if (settings) store.update('settings', s => ({ ...s, ...settings }));
                        if (scenarios) store.update('scenarios', () => scenarios);
                        if (connection) store.set({ connection });
                        this.sync();
                        this.renderAssumptions();
                        this.renderSpots();
                        this.renderPrices();
                        this.renderExport();
                        ui.toast(ignored.length ? `Imported, leaving out ${ignored.length} unusable item${ignored.length === 1 ? '' : 's'}.` : 'Imported.', { tone: 'good' });
                    },
                },
            ],
        });
    },

    /* ── 09 reset ─────────────────────────────────────────────────────────── */

    renderReset() {
        const { ui } = this.ctx;
        this.hosts.reset.replaceChildren(ui.card({
            className: 'mv-danger',
            body: ui.h('div', { class: 'mv-x', style: { borderTop: 0, padding: 0 } },
                ui.h('div', null,
                    ui.h('div', { class: 'mv-x-t' }, 'Reset everything'),
                    ui.h('div', { class: 'mv-x-d' }, 'Deletes your settings, assumptions, mount spots, saved scenarios, API key and cached downloads from this browser, then reloads the page. There is nothing to delete anywhere else.')),
                ui.h('div', { class: 'mv-x-acts' }, ui.button({ label: 'Reset everything…', kind: 'danger', onClick: () => this.confirmReset() }))),
        }));
    },

    confirmReset() {
        const { ui, store } = this.ctx;
        ui.modal({
            title: 'Reset everything?',
            body: ui.h('p', null, 'Your settings, saved scenarios, API key and cached weather downloads will be deleted from this browser. This can’t be undone — export your settings first if you might want them back.'),
            actions: [
                { label: 'Cancel' },
                {
                    label: 'Reset everything', danger: true,
                    onClick: () => {
                        this.ctx.shell.rerun.hide();
                        store.clearApiKey();
                        store.reset();
                        deleteCacheDb().finally(() => {
                            try { history.replaceState(null, '', '#verdict'); } catch { /* ignore */ }
                            location.reload();
                        });
                    },
                },
            ],
        });
    },
};
