/**
 * parseTextStyles — convert Claude's Markdown output to Telegram's native syntax.
 *
 * This system is Telegram-only.  ChannelType is a single-literal union to
 * keep the type system honest: anyone trying to pass another channel name
 * fails at compile time.
 *
 * Telegram MarkdownV1 transformations:
 *   - **bold**     → *bold*
 *   - *italic*     → _italic_
 *   - ## Heading   → *Heading*
 *   - [text](url)  → preserved (Telegram renders natively)
 *   - --- / *** / ___  →  stripped
 *
 * Code blocks (fenced and inline) are NEVER transformed by marker substitution.
 */

export type ChannelType = 'telegram';

/** Transform Markdown text for Telegram's native format. */
export function parseTextStyles(text: string, _channel: ChannelType): string {
  if (!text) return text;

  const segments = splitProtectedRegions(text);
  return segments
    .map(({ content, protected: isProtected }) =>
      isProtected ? content : transformSegment(content),
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Marker-substitution helpers (Telegram)
// ---------------------------------------------------------------------------

interface Segment {
  content: string;
  protected: boolean;
}

/**
 * Split text into alternating unprotected/protected segments.
 * Protected = fenced code blocks (```...```) and inline code (`...`).
 */
function splitProtectedRegions(text: string): Segment[] {
  const segments: Segment[] = [];
  const CODE_PATTERN = /^```[^\n]*\n[\s\S]*?\n```$|`[^`\n]+`/gm;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        content: text.slice(lastIndex, match.index),
        protected: false,
      });
    }
    segments.push({ content: match[0], protected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), protected: false });
  }

  return segments.length > 0 ? segments : [{ content: text, protected: false }];
}

/** Apply marker-substitution transformations to a non-code segment. */
function transformSegment(text: string): string {
  let t = text;

  // Order matters: italic before bold.
  // The italic regex won't match **bold** (it requires the char after the opening *
  // to be a non-* non-space), so running italic first is safe.  If we ran bold
  // first (**bold** → *bold*), the italic step would immediately re-convert *bold*
  // to _bold_, producing wrong output.

  // 1. Italic: *text* → _text_
  t = t.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '_$1_');

  // 2. Bold: **text** → *text*
  t = t.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');

  // 3. Headings: ## Title → *Title* (any level, line-start only)
  t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // 4. Links: Telegram MarkdownV1 renders [text](url) natively — preserve.

  // 5. Horizontal rules: strip them
  t = t.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');

  return t;
}
