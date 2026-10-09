// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const CUSTOMERS = [
  { name: 'Riley Fern', address: '2841 E. Copper Wren Lane', city: 'Mesa, AZ 85213', email: 'riley@example.com' },
  { name: 'Morgan Reed', address: '7316 E. Desert Lantern Court', city: 'Mesa, AZ 85207', email: 'morgan@example.com' },
];
// Amounts are integer cents. These scopes cover labor; customers supply materials.
export const PROJECTS = [
  { number: '014', customer: 0, title: 'Native planting bed', daysAgo: 4, items: [
    ['Inspect and replace drip emitters', 6, 1500],
    ['Prepare bed and install supplied plants', 1, 24000],
    ['Haul green waste and sweep paths', 1, 4500],
  ] },
  { number: '015', customer: 1, title: 'Gravel garden refresh', daysAgo: 12, items: [
    ['Remove weeds and grade garden bed', 3, 6500],
    ['Spread customer-supplied gravel', 1, 18000],
    ['Reset edging and clean up', 1, 7500],
  ] },
  { number: '016', customer: 0, title: 'Patio border planting', daysAgo: 2, items: [
    ['Prepare planting pockets at patio', 4, 3500],
    ['Install customer-supplied desert plants', 4, 2500],
    ['Check irrigation and clean patio', 1, 6000],
  ] },
];
export const IRRIGATION = { number: '013', customer: 0, title: 'Irrigation tune-up', daysAgo: 21, items: [
  ['Inspect and replace drip emitters', 6, 1500],
  ['Flush lines and adjust watering zones', 1, 8500],
  ['Walk through system with customer', 1, 2500],
] };

export const demoDate = (now, daysAgo) => new Date(now.getTime() - daysAgo * 86400000);
const dateLabel = date => date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const money = cents => `$${(cents / 100).toFixed(2)}`;
const green = rgb(.16, .32, .25), ink = rgb(.17, .21, .20), muted = rgb(.40, .44, .41), rule = rgb(.80, .84, .80);

async function stationery(title, date) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(title); pdf.setAuthor('Mesa Sprout Landscaping'); pdf.setCreationDate(date); pdf.setModificationDate(date);
  const text = (value, x, y, size = 10, face = font, color = ink) => page.drawText(value, { x, y, size, font: face, color });
  const right = (value, x, y, size = 10, face = font) => text(value, x - face.widthOfTextAtSize(value, size), y, size, face);
  const line = (x1, y, x2) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: .7, color: rule });
  page.drawRectangle({ x: 48, y: 737, width: 34, height: 4, color: green });
  text('Mesa Sprout Landscaping', 48, 708, 23, bold, green);
  text('1862 E. Sunpetal Way  |  Mesa, AZ 85204', 48, 688, 10, font, muted);
  text('(480) 555-0142  |  hello@example.com', 48, 672, 10, font, muted);
  line(48, 653, 564);
  line(48, 61, 564);
  text('Made with PickBits File Share', 48, 42, 9, font, muted);
  right('1', 564, 42, 9);
  return { pdf, page, font, bold, text, right, line };
}

export async function businessPdf(kind, project, now = new Date()) {
  const date = demoDate(now, project.daysAgo), customer = CUSTOMERS[project.customer];
  const title = `${kind} #${date.getUTCFullYear()}-${project.number}`;
  const { pdf, page, font, bold, text, right, line } = await stationery(title, date);
  text(title, 48, 619, 19, bold, green);
  right(dateLabel(date), 564, 622);
  text(kind === 'Invoice' ? 'BILL TO' : 'PREPARED FOR', 48, 580, 9, bold, muted);
  text(customer.name, 48, 560, 12, bold);
  text(customer.address, 48, 543);
  text(customer.city, 48, 527);
  text('PROJECT', 338, 580, 9, bold, muted);
  text(project.title, 338, 560, 11, bold);
  text('Labor and installation services', 338, 542, 10, font, muted);
  text('Materials supplied by customer', 338, 526, 10, font, muted);
  page.drawRectangle({ x: 48, y: 475, width: 516, height: 28, color: green });
  text('DESCRIPTION', 60, 485, 9, bold, rgb(1, 1, 1));
  for (const [label, edge] of [['QTY', 376], ['RATE', 459], ['AMOUNT', 552]]) {
    text(label, edge - bold.widthOfTextAtSize(label, 9), 485, 9, bold, rgb(1, 1, 1));
  }
  project.items.forEach(([label, quantity, cents], index) => {
    const y = 449 - index * 38;
    text(label, 60, y, 10);
    right(String(quantity), 376, y); right(money(cents), 459, y); right(money(quantity * cents), 552, y);
    line(48, y - 14, 564);
  });
  const subtotal = project.items.reduce((total, [, quantity, cents]) => total + quantity * cents, 0);
  const totalsY = 449 - project.items.length * 38;
  text('Subtotal', 363, totalsY); right(money(subtotal), 552, totalsY);
  text('Tax (labor only)', 363, totalsY - 22); right('$0.00', 552, totalsY - 22);
  page.drawRectangle({ x: 350, y: totalsY - 63, width: 214, height: 29, color: rgb(.92, .95, .92) });
  text(kind === 'Invoice' ? 'Amount due' : 'Total', 363, totalsY - 53, 12, bold); right(money(subtotal), 552, totalsY - 53, 12, bold);
  text(kind === 'Invoice' ? 'PAYMENT DETAILS' : 'TERMS & ACCEPTANCE', 48, 235, 9, bold, green);
  const terms = kind === 'Invoice'
    ? [`Payment due ${dateLabel(demoDate(date, -30))}. Please include the invoice number.`, 'Work is complete. Contact Avery Rowan with any questions about this invoice.']
    : ['Valid for 30 days from the date above. Scheduling follows written approval.', 'Payment is due on completion. Scope changes require written approval.', 'Customer supplies plants and materials. Both parties accept the scope above.'];
  terms.forEach((value, index) => text(value, 48, 214 - index * 17, 10));
  if (kind !== 'Invoice') {
    line(48, 116, 287); line(325, 116, 564);
    text('Customer signature / date', 48, 100, 9, font, muted);
    text('Avery Rowan, Mesa Sprout / date', 325, 100, 9, font, muted);
    if (kind === 'Agreement') text('Electronic signatures are recorded on the attached signatures page.', 48, 79, 9, font, muted);
  }
  return Buffer.from(await pdf.save());
}

export async function guidePdf(kind, now = new Date()) {
  const handbook = kind === 'Crew handbook';
  const { pdf, text, bold, line } = await stationery(kind, demoDate(now, handbook ? 56 : 35));
  text(kind, 48, 615, 23, bold, green);
  text(handbook ? 'Field reference  |  Crew edition 2026' : 'New desert planting  |  Customer reference', 48, 592, 11);
  const sections = handbook ? [
    ['01  Before leaving the yard', ['Review the job notes and confirm the customer access window.', 'Pack gloves, eye protection, water, first-aid kit and the materials list.', 'Check tools, secure the load and tell Avery when the crew is on the way.']],
    ['02  At the property', ['Walk the scope with the customer before unloading.', 'Photograph the work area, gates and existing irrigation.', 'Protect patio edges and keep a clear path through the yard.']],
    ['03  Close out the job', ['Test each irrigation zone and clear debris from paths.', 'Take after photos from the same positions as the before photos.', 'Leave the plant care sheet and record follow-up items in the job folder.']],
    ['04  Crew contacts', ['Avery Rowan - scheduling and estimates - avery@example.com', 'Jordan Vale - field work and photos - jordan@example.com', 'Office: (480) 555-0142  |  hello@example.com']],
  ] : [
    ['01  Settle the roots', ['Check the soil around each root ball before watering.', 'Water slowly at the root zone; avoid runoff onto the patio.', 'Keep gravel clear of plant stems and crowns.']],
    ['02  Check the drip system', ['Watch each emitter during a full watering cycle.', 'Look for leaks, blocked outlets and tubing disturbed by pets.', 'Adjust the schedule for rainfall, temperature and the plant variety.']],
    ['03  Keep the bed tidy', ['Remove weeds by hand while they are small.', 'Leave space around new plants for their mature spread.', 'Avoid heavy pruning while plants are settling into the bed.']],
    ['04  Follow-up visit', ['Keep a note of any wilting or standing water between cycles.', 'Send Avery a photo if a plant or emitter needs attention.', 'Office: (480) 555-0142  |  hello@example.com']],
  ];
  sections.forEach(([heading, lines], index) => {
    const y = 546 - index * 111;
    text(heading, 48, y, 13, bold, green);
    lines.forEach((value, offset) => text(value, 48, y - 25 - offset * 17, 11));
    if (index < sections.length - 1) line(48, y - 80, 564);
  });
  return Buffer.from(await pdf.save());
}
