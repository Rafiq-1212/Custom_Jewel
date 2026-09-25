/**
 * The same image calls as lib/gemini.ts, submitted as batch jobs.
 *
 * Google charges half price for a call that may be answered whenever it
 * suits them: $30 per million image tokens instead of $60. That is the only
 * lever on this app's cost that does not touch the picture — the model, the
 * prompt and the output are identical, and a batched 4K sketch put beside a
 * live one is the same drawing.
 *
 * What it costs instead is time, and the two measured jobs show how uneven
 * that is: the 1K photo edit came back in 87 seconds, the 4K drawing in 379.
 * Both are far quicker than the 24 hours Google promises, and both are far
 * too long for one HTTP request — which is why nothing here waits. Each
 * function either submits a job or reads one, and the browser does the
 * waiting (see app/api/sketch/route.ts).
 *
 * A job's result stays retrievable from Google afterwards, and that is what
 * keeps this stateless: the photo edit does not have to be stored anywhere
 * between requests, because the job that produced it can simply be read
 * again. It is also what makes a redraw cheap — the same photo-edit job is
 * reused and only the drawing is paid for a second time.
 */

import { GoogleGenAI, Modality } from '@google/genai';
import { GeminiGenerationError, MODEL_ID, classifyThrown, type GenerateImageFromImageInput, type GenerateImageResult } from './gemini';
import { priceImageCall, recordCall } from './cost';

if (typeof window !== 'undefined') {
  throw new Error('lib/gemini-batch.ts was imported into a browser bundle. This module is server-only.');
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiGenerationError('MISSING_API_KEY', 'GEMINI_API_KEY is not set in the environment.');
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

/** Submits one image call and returns the job's name, which is the only thing anyone needs to keep. */
export async function submitImageJob(input: GenerateImageFromImageInput, label: string): Promise<string> {
  const ai = getClient();
  try {
    const job = await ai.batches.create({
      model: MODEL_ID,
      src: [
        {
          contents: [
            {
              role: 'user',
              parts: [
                { text: input.prompt },
                ...input.images.map((image) => ({
                  inlineData: { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString('base64') },
                })),
              ],
            },
          ],
          config: {
            responseModalities: [Modality.TEXT, Modality.IMAGE],
            ...(input.imageSize ? { imageConfig: { imageSize: input.imageSize } } : {}),
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          },
        },
      ],
      config: { displayName: label },
    });
    if (!job.name) throw new GeminiGenerationError('REQUEST_FAILED', 'The batch job came back without a name.');
    console.info(`[batch] submitted ${label}: ${job.name}`);
    return job.name;
  } catch (error) {
    throw classifyThrown(error);
  }
}

export type JobState = 'running' | 'done' | 'failed';

/** Whether a job has finished, without fetching anything heavy. */
export async function readJobState(name: string): Promise<JobState> {
  const ai = getClient();
  let state: string | undefined;
  try {
    state = (await ai.batches.get({ name })).state as string | undefined;
  } catch (error) {
    throw classifyThrown(error);
  }
  if (state === 'JOB_STATE_SUCCEEDED') return 'done';
  if (state === 'JOB_STATE_FAILED' || state === 'JOB_STATE_CANCELLED' || state === 'JOB_STATE_EXPIRED') return 'failed';
  return 'running';
}

interface InlinedResult {
  response?: {
    usageMetadata?: Parameters<typeof priceImageCall>[0];
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] }; finishReason?: string }[];
  };
  error?: unknown;
}

/**
 * The image a finished job produced.
 *
 * `count` decides whether this read is added to the request's cost total.
 * Reading a finished job does not re-run anything — Google charges once, when
 * the job runs — but the same job is read more than once across the steps of
 * a sketch, so exactly one of those reads is the one that counts. Default off,
 * so a read can never quietly inflate the figure the shop is shown.
 */
export async function readImageJob(name: string, label: string, options: { count?: boolean } = {}): Promise<GenerateImageResult> {
  const ai = getClient();
  let job;
  try {
    job = await ai.batches.get({ name });
  } catch (error) {
    throw classifyThrown(error);
  }

  const state = job.state as string | undefined;
  if (state !== 'JOB_STATE_SUCCEEDED') {
    throw new GeminiGenerationError('REQUEST_FAILED', `Batch job ${name} is ${state ?? 'unknown'}, not finished.`);
  }

  const results = ((job.dest as { inlinedResponses?: InlinedResult[] } | undefined)?.inlinedResponses ?? []) as InlinedResult[];
  const result = results[0];
  if (!result) throw new GeminiGenerationError('EMPTY_RESPONSE', `Batch job ${name} finished with no response.`);
  if (result.error) {
    throw new GeminiGenerationError('REQUEST_FAILED', `Batch job ${name} returned an error: ${JSON.stringify(result.error).slice(0, 200)}`);
  }

  const usage = result.response?.usageMetadata;
  if (usage && options.count) {
    const usd = priceImageCall(usage, { batch: true });
    recordCall(`batched ${label}`, usd);
    console.info(`[batch] ${label} done: cost=$${usd.toFixed(4)} (half the interactive price)`);
  }

  const candidate = result.response?.candidates?.[0];
  const part = candidate?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) {
    throw new GeminiGenerationError('EMPTY_RESPONSE', `Batch job ${name} finished without an image (${candidate?.finishReason ?? 'no reason given'}).`);
  }
  return { bytes: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType || 'image/png' };
}
