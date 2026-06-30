export enum FormatAnswersContentReason {
  NO_USABLE_ANSWER = 'no_usable_answer',
  INCOMPLETE_RESEARCH = 'incomplete_research',
}

export const NO_USABLE_ANSWER_MESSAGE = 'No answer content was returned by the Answers API.';
export const INCOMPLETE_RESEARCH_MESSAGE =
  'Research did not complete with a synthesized answer. Try lowering research_maximum_number_of_iterations or increasing research_maximum_number_of_seconds.';

type FormatAnswersContentOptions = {
  enable_research?: boolean;
  enable_citations?: boolean;
  enable_entities?: boolean;
};

type FormatAnswersContentResult =
  | { ok: true; text: string }
  | { ok: false; reason: FormatAnswersContentReason };

enum EnumListTypes {
  ORDERED = 'ol',
  UNORDERED = 'ul',
}

type EnumItemPayload = {
  uuid?: string;
  original_tokens?: string;
  citations?: Record<string, unknown>;
  name?: string;
  href?: string;
};

type CitationPayload = {
  start_index?: number;
  end_index?: number;
  number?: number;
  url?: string;
  favicon?: string;
  snippet?: string;
};

const USAGE_BLOCK_PATTERN = /<usage>[\s\S]*?<\/usage>/g;
const CITATION_CAPTURE_PATTERN = /<citation>([\s\S]*?)<\/citation>/g;
const ENUM_LIST_CONTAINER_CAPTURE_PATTERN =
  /<enum_start>([\s\S]*?)<\/enum_start>([\s\S]*?)<enum_end>[\s\S]*?<\/enum_end>/g;
const ENUM_ITEM_CAPTURE_PATTERN = /<enum_item>([\s\S]*?)<\/enum_item>/g;
const ANSWER_CAPTURE_PATTERN = /<answer>([\s\S]*?)<\/answer>/g;

function labelifyCitationLink(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

function markdownifyCitationFootnote(citation: CitationPayload): string {
  const { number, url, snippet } = citation;
  const href = url?.trim();
  if (number === undefined || !href) return '';

  const footnote = `[^${number}]: [${labelifyCitationLink(href)}](${href})`;
  const excerpt = snippet?.trim();
  return excerpt ? `${footnote} — ${excerpt}` : footnote;
}

function markdownifyEnumList(
  inner: string,
  listType: EnumListTypes = EnumListTypes.UNORDERED,
  index = 1
): string {
  const trimmed = inner.trim();
  if (trimmed.length === 0) return '';

  try {
    const parsed = JSON.parse(trimmed) as EnumItemPayload;
    const label = parsed.original_tokens?.trim() || parsed.name?.trim();
    if (!label) return '';

    let content = label;
    if (parsed.href) {
      const href = parsed.href.trim();
      if (/^https?:\/\//i.test(href)) {
        content = `[${label}](${href})`;
      }
    }

    const marker = listType === EnumListTypes.ORDERED ? `${index}. ` : '* ';
    return `${marker}${content}`;
  } catch {
    return '';
  }
}

function formatEnumListItems(itemsText: string, listType: EnumListTypes): string {
  let index = 1;
  const matches = itemsText.matchAll(ENUM_ITEM_CAPTURE_PATTERN);
  return Array.from(matches).reduce((acc, match) => {
    const line = markdownifyEnumList(match[1], listType, index);
    if (line.length === 0) return acc;
    if (listType === EnumListTypes.ORDERED) index++;
    return `${acc}\n${line}`;
  }, '');
}

function formatSingleSearchAnswer(
  raw_answer: string,
  options: FormatAnswersContentOptions
): string {
  let formatted: string = raw_answer.trim();
  formatted = formatted.replace(USAGE_BLOCK_PATTERN, '').trim();
  if (options.enable_citations) {
    formatted = markdownifyCitationBlocks(formatted);
  }
  if (options.enable_entities) {
    formatted = markdownifyEnumBlocks(formatted);
  }
  return formatted.trim();
}

export function markdownifyCitationBlocks(text: string): string {
  const citationMap = new Map<number, CitationPayload>();

  const body = text.replace(CITATION_CAPTURE_PATTERN, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed.length === 0) return '';

    try {
      const parsed = JSON.parse(trimmed) as CitationPayload;
      if (typeof parsed.number !== 'number' || !Number.isFinite(parsed.number)) {
        return '';
      }

      citationMap.set(parsed.number, parsed);
      return `[^${parsed.number}]`;
    } catch {
      return '';
    }
  });

  const trimmedBody = body.trimEnd();
  if (citationMap.size === 0) return trimmedBody;

  const footnotes = [...citationMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, citation]) => markdownifyCitationFootnote(citation))
    .filter((line) => line.length > 0);

  if (footnotes.length === 0) return trimmedBody;

  return `${trimmedBody}\n\n${footnotes.join('\n')}`;
}

export function markdownifyEnumBlocks(rawEnumBlock: string): string {
  let result = rawEnumBlock.replace(
    ENUM_LIST_CONTAINER_CAPTURE_PATTERN,
    (_match, rawListType: string, rawInnerList: string) => {
      const listType =
        rawListType.toLowerCase().trim() === EnumListTypes.ORDERED
          ? EnumListTypes.ORDERED
          : EnumListTypes.UNORDERED;
      return formatEnumListItems(rawInnerList, listType);
    }
  );

  result = result.replace(ENUM_ITEM_CAPTURE_PATTERN, (_match, rawEnumItem: string) => {
    const formatted = markdownifyEnumList(rawEnumItem);
    return formatted.length > 0 ? `\n${formatted}` : '';
  });

  return result;
}

export function extractResearchAnswer(text: string): string | null {
  const answer_blocks: string[] = [];
  for (const match of text.matchAll(ANSWER_CAPTURE_PATTERN)) {
    answer_blocks.push(match[1]);
  }

  const trimmed = answer_blocks.at(-1)?.trim();
  if (trimmed === undefined || trimmed.length === 0) return null;

  try {
    const parsed = JSON.parse(trimmed) as { answer?: string };
    if (typeof parsed.answer === 'string' && parsed.answer.length > 0) {
      return parsed.answer;
    }
  } catch {}

  return trimmed;
}

export function formatAnswersContent(
  raw: string,
  options: FormatAnswersContentOptions = {}
): FormatAnswersContentResult {
  if (options.enable_research) {
    const answer = extractResearchAnswer(raw);
    if (!answer) {
      return { ok: false, reason: FormatAnswersContentReason.INCOMPLETE_RESEARCH };
    }

    return { ok: true, text: answer };
  }

  const formatted = formatSingleSearchAnswer(raw, options);
  if (formatted.length === 0) {
    return { ok: false, reason: FormatAnswersContentReason.NO_USABLE_ANSWER };
  }

  return { ok: true, text: formatted };
}
