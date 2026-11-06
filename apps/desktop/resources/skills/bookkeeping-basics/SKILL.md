---
name: bookkeeping-basics
description: I read this when I record income and expenses, collect receipts, write invoices or monthly finance reports - simple, reliable books with one ledger, receipts linked to every entry, categories, invoices with the required fields, monthly reconciliation and exports for the tax advisor.
metadata:
  modes:
    - finance
    - secretary
---

# Bookkeeping basics

I prepare clean records. Binding tax or legal advice is the tax advisor's; I mark questions for
them and give them good exports.

## The ledger
One canonical ledger per entity (company, private) in the finance workspace, e.g. a CSV or
spreadsheet. Columns:
```
date, type (income|expense|transfer), amount_net, tax_rate, tax_amount, amount_gross,
currency, counterparty, description, category, payment_method, receipt_path, invoice_no, status
```
- Amounts as numbers with two decimals; currency explicit.
- One ledger for one thing: a second one splits the truth. Corrections are new rows or edits with a note, not
  silent overwrites of history.
- I keep company and private money strictly apart.

## Receipts
- Every entry links a receipt file: `receipts/2026/10/2026-10-14_hosting-provider_12.50.pdf`
  (date_counterparty_amount).
- I fetch receipts myself where I can: provider portals (in my browser profile),
  email attachments, download pages.
- Receipts I cannot get go to the human as one `checklist` per month, not one item
  each.
- I keep originals unchanged and store the file, not a screenshot, when a PDF exists.

## Categories
I use a small, stable list agreed with the human or advisor (e.g. software, hosting,
hardware, travel, marketing, fees, office, income-services, income-products), the same for
every entry. Unclear → "to-clarify", listed in the monthly report.

## Invoices (outgoing)
Required content depends on the country. For Germany typically: full name and address of
both parties, tax number or VAT id, invoice date, unique sequential invoice number, date of
service, description and quantity, net amount, tax rate and amount (or the reason for no
VAT, e.g. small-business rule), gross amount. I use the human's template. Tax details come from
them, not from my guess: I ask once and save them as company facts.
- Before sending an invoice, I check amount and recipient once.
- I schedule a payment check at the due date (`proactive-follow-ups`).

## Monthly close
1. I import or copy bank/card statements for the month.
2. I match every statement line to a ledger entry (amount, date ± a few days, counterparty).
3. I list unmatched items both ways and resolve them or mark them to-clarify.
4. I check open invoices (sent, unpaid past due).
5. I report:
```ui
{"type":"stats","title":"October 2026","items":[
 {"label":"Income","value":"4,820 €"},{"label":"Expenses","value":"1,135 €"},
 {"label":"Open invoices","value":"2"},{"label":"Missing receipts","value":"1"}]}
```
Plus a `table` of open items, with short text.

## Exports
For the advisor: the ledger as CSV, receipts folder zipped per month, a short notes file
with to-clarify items. When I know the format they ask for exactly (e.g. DATEV-compatible CSV),
I use it; when I don't, I ask.

## Pitfalls
- Mixing gross and net in one column.
- Duplicates from importing the same statement twice - I check by date+amount+counterparty.
- Deleting or overwriting receipt files.
