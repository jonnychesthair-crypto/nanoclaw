---
name: office-tools
description: Create, edit, and convert Microsoft Office documents (Word, Excel, PowerPoint) and PDFs using LibreOffice and pandoc. Use for any document creation or conversion task.
allowed-tools: Bash(libreoffice:*), Bash(pandoc:*), Bash(soffice:*)
---

# Office Document Tools

LibreOffice and pandoc are available for creating, editing, and converting documents.

## Creating Documents

### Word documents (.docx)

Option 1 — Write Markdown, convert with pandoc:
```bash
cat > doc.md << 'EOF'
# Report Title
## Section 1
Content here with **bold** and *italic*.

| Column A | Column B |
|----------|----------|
| Data 1   | Data 2   |
EOF
pandoc doc.md -o report.docx
```

Option 2 — Use LibreOffice with a template or from scratch:
```bash
# Convert any supported format to DOCX
libreoffice --headless --convert-to docx input.odt
```

### Excel spreadsheets (.xlsx)

Create a CSV then convert:
```bash
cat > data.csv << 'EOF'
Name,Amount,Date
Item A,100,2026-01-15
Item B,250,2026-02-20
EOF
libreoffice --headless --convert-to xlsx data.csv
```

### PowerPoint presentations (.pptx)

Create from Markdown with pandoc:
```bash
cat > slides.md << 'EOF'
---
title: Presentation Title
author: Author Name
---

# Slide 1 Title
- Bullet point 1
- Bullet point 2

# Slide 2 Title
- More content
EOF
pandoc slides.md -o presentation.pptx
```

### PDF creation

```bash
# From Markdown
pandoc report.md -o report.pdf

# From any Office format
libreoffice --headless --convert-to pdf document.docx
libreoffice --headless --convert-to pdf spreadsheet.xlsx
```

## Editing Existing Documents

### Edit a Word document
```bash
# Convert to editable format, modify, convert back
libreoffice --headless --convert-to odt document.docx
# ... edit the .odt file ...
libreoffice --headless --convert-to docx document.odt
```

### Edit a spreadsheet
```bash
# Convert to CSV for editing
libreoffice --headless --convert-to csv spreadsheet.xlsx
# ... edit the CSV ...
libreoffice --headless --convert-to xlsx edited.csv
```

## Format Conversion

```bash
# DOCX → PDF
libreoffice --headless --convert-to pdf document.docx

# PDF → text (use pdf-reader)
pdf-reader extract document.pdf --layout

# Markdown → DOCX/PDF/PPTX
pandoc input.md -o output.docx
pandoc input.md -o output.pdf
pandoc input.md -o output.pptx

# HTML → DOCX
pandoc page.html -o document.docx

# DOCX → Markdown
pandoc document.docx -o output.md
```

## Tips

- Always use `--headless` with LibreOffice (no GUI available).
- For tables in Word docs, pandoc handles Markdown tables well.
- For complex spreadsheets, build the CSV programmatically then convert.
- Use `libreoffice --headless --infilter="CSV:44,34,76,1" --convert-to xlsx` for CSV with specific delimiter settings.
