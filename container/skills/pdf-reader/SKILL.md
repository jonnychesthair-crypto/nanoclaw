---
name: pdf-reader
description: Read and extract text from PDF files — documents, reports, contracts, spreadsheets. Use whenever you need to read PDF content, not just when explicitly asked. Handles local files, URLs, and attachments.
allowed-tools: Bash(pdf-reader:*)
---

# PDF Reader

## Quick start

```bash
pdf-reader extract report.pdf              # Extract all text
pdf-reader extract report.pdf --layout     # Preserve tables/columns
pdf-reader fetch https://example.com/doc.pdf  # Download and extract
pdf-reader info report.pdf                 # Show metadata + size
pdf-reader list                            # List all PDFs in directory tree
```

## Commands

### extract — Extract text from PDF

```bash
pdf-reader extract <file>                        # Full text to stdout
pdf-reader extract <file> --layout               # Preserve layout (tables, columns)
pdf-reader extract <file> --pages 1-5            # Pages 1 through 5
pdf-reader extract <file> --pages 3-3            # Single page (page 3)
pdf-reader extract <file> --layout --pages 2-10  # Layout + page range
```

Options:
- `--layout` — Maintains spatial positioning. Essential for tables, spreadsheets, multi-column docs.
- `--pages N-M` — Extract only pages N through M (1-based, inclusive).

### fetch — Download and extract PDF from URL

```bash
pdf-reader fetch <url>                    # Download, verify, extract with layout
pdf-reader fetch <url> report.pdf         # Also save a local copy
```

### info — PDF metadata and file size

```bash
pdf-reader info <file>
```

### list — Find all PDFs in directory tree

```bash
pdf-reader list
```

## Attachment PDFs

When a user sends a PDF, it may be saved to the `attachments/` directory. To read:

```bash
pdf-reader extract attachments/document.pdf --layout
```
