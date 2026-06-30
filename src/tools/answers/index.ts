import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ZodError } from 'zod';
import { issuePostRequest, issueStreamingPostRequest } from '../../BraveAPI/index.js';
import { AnswersInputSchema, type AnswersInput } from './schemas/input.js';
import type { ChatCompletionResponse } from './schemas/output.js';
import {
  formatAnswersContent,
  FormatAnswersContentReason,
  INCOMPLETE_RESEARCH_MESSAGE,
  NO_USABLE_ANSWER_MESSAGE,
} from './format.js';
import {
  ANSWERS_PROGRESS_INTERVAL_MS,
  createAnswersProgressNotifier,
  type AnswersToolExtra,
} from './progress.js';
import { getAnswersStreamingTimeoutMs } from './timeout.js';

export const name = 'brave_answers';

const ANSWERS_PATH = '/res/v1/chat/completions';

export const annotations: ToolAnnotations = {
  title: 'Brave Answers',
  openWorldHint: true,
};

export const description = `
    Generates AI-grounded answers backed by real-time Brave Search using the Answers API (OpenAI-compatible /chat/completions endpoint).

    Preferred replacement for brave_summarizer: Pass your question in messages instead of chaining brave_web_search (summary: true) + brave_summarizer.

    When to use:
        - When you need a finished, web-grounded answer rather than raw search results
        - For quick factual Q&A with optional inline citations
        - For deeper multi-search research on complex topics (enable_research)
        - As a drop-in alternative to chaining web search + summarization

    Two upstream modes:
        - Single-search (default): Fast grounded answer from one search. Supports enable_citations.
        - Research (enable_research=true): Iterative multi-search synthesis. Slower; may take up to several minutes.

    Request parameters mirror the Answers API request body. Set stream=true to use Server-Sent Events; this MCP tool buffers streamed responses before returning.

    Requires an Answers plan. See https://api-dashboard.search.brave.com/app/subscriptions/subscribe
`.trim();

export const execute = async (
  params: AnswersInput,
  extra?: AnswersToolExtra
): Promise<CallToolResult> => {
  const response: CallToolResult = { content: [], isError: false };

  try {
    const body = AnswersInputSchema.parse(params);

    let rawText = '';

    if (body.stream) {
      const timeoutMs = getAnswersStreamingTimeoutMs(body);
      const progressMessage = 'Waiting for answer…';
      const progressTotalSteps = Math.ceil(timeoutMs / ANSWERS_PROGRESS_INTERVAL_MS);

      rawText = await issueStreamingPostRequest(
        ANSWERS_PATH,
        body,
        {},
        {
          timeoutMs,
          signal: extra?.signal,
          onProgress: createAnswersProgressNotifier(extra, progressMessage, {
            totalSteps: progressTotalSteps,
          }),
          progressIntervalMs: ANSWERS_PROGRESS_INTERVAL_MS,
        }
      );
    } else {
      const result = await issuePostRequest<ChatCompletionResponse>(ANSWERS_PATH, body);
      rawText = result.choices?.[0]?.message?.content ?? '';
    }

    const formatted = formatAnswersContent(rawText, {
      enable_research: body.enable_research,
      enable_citations: body.enable_citations,
      enable_entities: body.enable_entities,
    });

    if (!formatted.ok) {
      let errorMessage: string;
      switch (formatted.reason) {
        case FormatAnswersContentReason.INCOMPLETE_RESEARCH:
          errorMessage = INCOMPLETE_RESEARCH_MESSAGE;
          break;
        case FormatAnswersContentReason.NO_USABLE_ANSWER:
        default:
          errorMessage = NO_USABLE_ANSWER_MESSAGE;
      }
      response.isError = true;
      response.content.push({ type: 'text', text: errorMessage });
      return response;
    }

    response.content.push({
      type: 'text',
      text: formatted.text,
    });
  } catch (error) {
    response.isError = true;
    const message =
      error instanceof ZodError
        ? (error.issues[0]?.message ?? 'Invalid request.')
        : error instanceof Error
          ? error.message
          : String(error);
    response.content.push({
      type: 'text',
      text: message,
    });
  }

  return response;
};

export const register = (mcpServer: McpServer) => {
  mcpServer.registerTool(
    name,
    {
      title: name,
      description: description,
      inputSchema: AnswersInputSchema.shape,
      annotations: annotations,
    },
    execute
  );
};

export default {
  name,
  description,
  annotations,
  inputSchema: AnswersInputSchema.shape,
  execute,
  register,
};
