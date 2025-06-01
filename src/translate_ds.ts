import axios from 'axios';
import * as fs from 'fs/promises';
import { createWriteStream, WriteStream as NodeFsWriteStream } from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import readline from 'readline';
import { RAW_DL_DIR, getOrLoadSeriesConfig, TL_DIR, SERIES_CONFIG_FILE } from './lib/config';
import { PromisePool } from './lib/promise-pool';

import type { SeriesConfigurations, SingleSeriesConfig } from './lib/schema';
// DeepSeek API Configuration
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL_NAME = process.env.DEEPSEEK_MODEL_NAME || 'deepseek-chat'; // Or any other specific model you want to use, e.g., 'deepseek-coder' for code-related tasks
const API_KEY = process.env.APIKEY_DEEPSEEK;

// Concurrency for translation tasks
const TRANSLATION_CONCURRENCY = parseInt(process.env.TRANSLATION_CONCURRENCY || "3", 10);

// Dry run mode: if true, no API calls or file writes will occur.
const DRY_RUN_TRANSLATION = process.env.DRY_RUN_TRANSLATION === 'true';

// Thresholds for output size warning
const OUTPUT_SIZE_THRESHOLD_FACTOR = 0.2; // If output is less than 20% of input
const MIN_INPUT_SIZE_FOR_WARNING = 100; // Bytes, for the input to be considered substantial enough for this warning
// Temporary directory for live translation streams
const TMP_DIR = path.resolve('tmp', 'live-translations');

async function listTextFiles(dir: string): Promise<string[]> {
    try {
        const files = await fs.readdir(dir);
        return files.filter(file => file.endsWith('.txt'));
    } catch (error: any) {
        console.warn(`⚠️ Could not read directory ${dir}: ${error.message}. Skipping.`);
        return [];
    }
}

async function readFileContent(filePath: string): Promise<string> {
    return await fs.readFile(filePath, 'utf-8');
}

async function writeToFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8');
}

function extractTranslation(content: string): string {
    // This function assumes the API returns only the translated text.
    // If DeepSeek adds any specific prefixes/suffixes that are not part of the translation,
    // they would need to be stripped here. For now, it's a direct pass-through.
    return content.trim();
}

export async function translateChapterWithRetry(
    chineseText: string,
    glossary?: string,
    customInstructions?: string,
    identifier?: string,
    originalFilename?: string,
    maxAttempts = 3
): Promise<string> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`\n🈸 Attempt ${attempt} to translate chapter...`);
        try {
            const result = await translateChapter(chineseText, glossary, customInstructions, identifier, originalFilename);
            console.log('✅ Chapter translated successfully.');
            return result;
        } catch (err: any) {
            console.warn(`⚠️ Attempt ${attempt} failed: ${err.message}. Retrying...`);
            await new Promise(res => setTimeout(res, 5000 * attempt)); // Increased backoff
        }
    }

    throw new Error('❌ All retries failed.');
}

async function translateChapter(
    chineseText: string,
    glossary?: string,
    customInstructions?: string,
    identifier?: string,
    originalFilename?: string
): Promise<string> {
    if (!API_KEY) {
        throw new Error("APIKEY_DEEPSEEK environment variable is not set.");
    }

    let tempFileStream: NodeFsWriteStream | null = null;
    let tempFilePath: string | null = null;

    const systemPromptParts = [
`Role & Objective:
You are a professional literary translator specializing in Chinese-to-English web novels. Your task is to produce a natural, emotionally resonant English translation that:
* Preserves the original's tone (e.g., melancholic, romantic, dramatic)
* Conveys cultural nuances without awkward literalness
* Maintains character voices and stylistic quirks
* Flows like native English prose

Key Guidelines:
* Dialogue: Keep conversations dynamic. Use contractions ("don't," "can't") and informal phrasing where appropriate.
* Inner Monologues: Use italicization for emphasis and stream-of-consciousness pacing.
* Descriptions: Prioritize vividness over literal accuracy (e.g., "心绪复杂" → "his mind weighed down with unspoken thoughts").
* Cultural Terms: Localize idioms (e.g., "刀子不落在自己身上" → "When the knife doesn't cut your own flesh").
* Pacing: Short sentences for tension, longer ones for introspection.`
    ];

    if (glossary && glossary.trim() !== "") {
        systemPromptParts.push(`
Glossary:
Use the provided glossary to handle specific names, terms, and locations.
- Render proper names using the standardized Pinyin or specific English equivalent from the glossary.
- Do NOT literally translate names or terms that are defined in the glossary; use the glossary's version. For example, if the glossary states "龙傲天" is "Long Aotian", use "Long Aotian".
--- GLOSSARY START ---
${glossary}
--- GLOSSARY END ---`);
    }

    if (customInstructions && customInstructions.trim() !== "") {
        systemPromptParts.push(`

${customInstructions}
`);
    }

systemPromptParts.push(`
Output Format:
* Bold chapter titles with consistent numbering (if applicable from input).
* Line breaks between paragraphs for readability.
* Italics for character thoughts or emphasis.
* "..." for trailing emotions, "—" for interrupted speech.

Task:
Translate the following Chinese web novel chapter while adhering to the above standards. Capture the emotional subtext and character dynamics faithfully. Produce ONLY the translated English text.
`);

    const systemContent = systemPromptParts.join('\n\n');

    const messages = [
        { role: 'system', content: systemContent },
        { role: 'user', content: chineseText }
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 480_000); // 8 minute timeout, slightly increased

    if (!DRY_RUN_TRANSLATION && identifier && originalFilename) {
        const safeOriginalFilename = originalFilename.replace(/\.txt$/i, '').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const tempFilename = `${Date.now()}_${identifier}_${safeOriginalFilename}_partial.txt`;
        tempFilePath = path.join(TMP_DIR, tempFilename);
        try {
            // TMP_DIR should be created by initializeEnvironment
            tempFileStream = createWriteStream(tempFilePath, { encoding: 'utf-8' });
            console.log(`[${identifier}] 🔴 Live streaming translation to temporary file: ${tempFilePath}`);
            tempFileStream.on('error', (err) => {
                console.warn(`\n[${identifier}] ⚠️ Error on temporary file stream ${tempFilePath}: ${err.message}`);
                tempFileStream = null;
            });
        } catch (e: any) {
            console.warn(`[${identifier}] ⚠️ Could not create temporary file stream for ${tempFilename}: ${e.message}`);
            tempFileStream = null;
        }
    }

    let finalOutput = '';

    try {
        const response = await axios.post(DEEPSEEK_API_URL, {
            model: DEEPSEEK_MODEL_NAME,
            messages: messages,
            temperature: 1.0, // Adjusted for potentially more creative literary translation
            top_p: 0.95,
            max_tokens: 8192, // Adjust as needed, ensures output isn't excessively long / controls cost
            stream: true
        }, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
            },
            responseType: 'stream',
            signal: controller.signal,
        });

        const stream = response.data as Readable;
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        for await (const line of rl) {
            if (!line.trim()) continue;

            // DeepSeek (and other OpenAI-compatible APIs) often send 'data: [DONE]' for stream termination
            if (line.trim() === 'data: [DONE]') {
                break;
            }

            if (line.startsWith('data: ')) {
                const jsonData = line.substring('data: '.length);
                try {
                    const data = JSON.parse(jsonData);
                    const token = data.choices?.[0]?.delta?.content || '';
                    if (token) {
                        finalOutput += token;
                        if (tempFileStream) {
                            tempFileStream.write(token);
                        }
                    }
                } catch (err: any) {
                    // It's possible to receive non-JSON data or metadata in the stream, log and ignore
                    console.warn('\n⚠️ Non-JSON line or parse error in stream:', line, err.message);
                }
            } else {
                 // Log unexpected lines that are not part of the Server-Sent Events (SSE) format
                 console.warn('\n⚠️ Unexpected line in stream (expected "data: ...") :', line);
            }
        }

    } catch (err: any) {
        clearTimeout(timeout); // Clear timeout explicitly on error
        if (axios.isCancel(err) || err.name === 'AbortError') {
            console.error('\n❌ Translation timed out or was aborted.');
            throw new Error('Translation timed out or aborted.');
        } else if (axios.isAxiosError(err)) {
            console.error(`\n❌ Axios error during translation: ${err.message}`);
            if (err.response) {
                console.error('Error Response Data:', err.response.data);
                console.error('Error Response Status:', err.response.status);
            }
            throw new Error(`API request failed: ${err.message}`);
        } else {
            console.error(`\n❌ Unexpected error during translation: ${err.message}`);
            throw err;
        }
    } finally {
        clearTimeout(timeout);
        if (tempFileStream) {
            tempFileStream.end(() => {
                if (tempFilePath) {
                    // If an error was thrown by axios/timeout, finalOutput might be partial.
                    // The temp file will reflect this. If no error, it's considered complete.
                    // Empty files are no longer removed.
                    console.log(`[${identifier}] ✅ Temporary live translation stream closed: ${tempFilePath}`);
                }
            });
        }
    }

    if (finalOutput.trim() === '') {
        console.warn("\n⚠️ Translation result is empty.");
    }
    
    return finalOutput;
}

async function initializeEnvironment(): Promise<void> {
    if (DRY_RUN_TRANSLATION) {
        console.log("💧 DRY RUN MODE ENABLED. No API calls will be made, and no files will be written.");
    } else {
        if (!API_KEY) {
            console.error("❌ APIKEY_DEEPSEEK environment variable is not set. Please set it before running the script.");
            throw new Error("APIKEY_DEEPSEEK environment variable is not set.");
        }
        console.log("✅ DeepSeek API Key found.");
    }
    
    await fs.mkdir(TL_DIR, { recursive: true });
    console.log(`✅ Output directory ${TL_DIR} ensured.`);
    if (!DRY_RUN_TRANSLATION) {
        await fs.mkdir(TMP_DIR, { recursive: true });
        console.log(`✅ Temporary live translation directory ${TMP_DIR} ensured.`);
    }

    const seriesConfigurations = await getOrLoadSeriesConfig();
    const seriesIdentifiers = await fs.readdir(RAW_DL_DIR, { withFileTypes: true })
        .then(dirents => dirents
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)
        )
        .catch(err => {
            console.error(`❌ Could not read series identifiers from ${RAW_DL_DIR}: ${err.message}`);
            return []; // Return empty array on error to prevent crash, main logic will handle it
        });

    if (seriesIdentifiers.length === 0 && Object.keys(seriesConfigurations).length > 0) {
        console.log(`No series subdirectories found in ${RAW_DL_DIR}, though configurations exist. Ensure raw files are downloaded and organized into subdirectories named by series identifier.`);
    } else if (seriesIdentifiers.length === 0) {
        console.log(`No series subdirectories found in ${RAW_DL_DIR}. Exiting.`);
    }
}

interface SeriesProcessingInfo {
    identifier: string;
    config: SingleSeriesConfig;
    inputFolder: string;
    outputFolder: string;
}

async function getSeriesToProcess(
    seriesConfigurations: SeriesConfigurations
): Promise<SeriesProcessingInfo[]> {
    const availableSeriesIdentifiers = await fs.readdir(RAW_DL_DIR, { withFileTypes: true })
        .then(dirents => dirents.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name))
        .catch(err => {
            console.error(`❌ Could not read series identifiers from ${RAW_DL_DIR}: ${err.message}`);
            return [];
        });

    if (availableSeriesIdentifiers.length === 0) {
        return [];
    }

    const seriesToProcess: SeriesProcessingInfo[] = [];

    for (const identifier of availableSeriesIdentifiers) {
        if (!seriesConfigurations[identifier]) {
            console.warn(`\n⏭️ Skipping series '${identifier}': No configuration found in '${SERIES_CONFIG_FILE}'.`);
            continue;
        }

        const seriesConfig = seriesConfigurations[identifier];
        if (seriesConfig.skipTranslation) {
            console.warn(`\n⏭️ Skipping series '${identifier}': Marked as skipTranslation in config.`);
            continue;
        }

        seriesToProcess.push({
            identifier,
            config: seriesConfig,
            inputFolder: path.join(RAW_DL_DIR, identifier),
            outputFolder: path.join(TL_DIR, identifier),
        });
    }
    return seriesToProcess;
}

async function createTranslationTask(
    identifier: string,
    file: string,
    inputPath: string,
    outputPath: string,
    glossary?: string,
    customInstructions?: string
): Promise<void> {
    console.log(`[${identifier}] 📖 Reading: ${file}`);
    const chineseText = await readFileContent(inputPath);

    // Handle empty input files
    if (!chineseText.trim()) {
        console.error(`[${identifier}] ❌ Content of ${file} is empty. Skipping translation. No output file will be created.`);
        // Do not create an output file if input is empty. This allows a rerun to pick it up
        // if the file was, for example, temporarily empty during a previous run.
        return;
    }

    // Dry run check for non-empty files
    if (DRY_RUN_TRANSLATION) {
        console.log(`[${identifier}] [DRY RUN] 🎯 Would translate: ${file}`);
        console.log(`[${identifier}] [DRY RUN] 💾 Would save to: ${outputPath}`);
        if (glossary) console.log(`[${identifier}] [DRY RUN] Would use glossary.`);
        if (customInstructions) console.log(`[${identifier}] [DRY RUN] Would use custom instructions.`);
        return;
    }

    console.log(`[${identifier}] 🌐 Translating: ${file} using DeepSeek API...`);
    try {
        const fullResponse = await translateChapterWithRetry(chineseText, glossary, customInstructions, identifier, file);
        const trimmed = extractTranslation(fullResponse);

        if (!trimmed) {
            console.error(`[${identifier}] ❌ Translation for ${file} resulted in empty output after trimming. Skipping file creation.`);
            return;
        }

        // Size check
        const inputSize = Buffer.from(chineseText).length;
        const outputSize = Buffer.from(trimmed).length;

        if (outputSize < inputSize * OUTPUT_SIZE_THRESHOLD_FACTOR && inputSize > MIN_INPUT_SIZE_FOR_WARNING) {
            console.warn(`[${identifier}] ⚠️ Translation output for ${file} (${outputSize} bytes) is significantly smaller than input (${inputSize} bytes) (threshold: <${OUTPUT_SIZE_THRESHOLD_FACTOR * 100}% of input for inputs >${MIN_INPUT_SIZE_FOR_WARNING} bytes). Please review manually. File will still be saved.`);
        }

        await writeToFile(outputPath, trimmed);
        console.log(`[${identifier}] 💾 Saved: ${outputPath}`);

    } catch (error: any) {
        // If translateChapterWithRetry throws, all retries failed. Log the error. No placeholder file is saved.
        // This allows a future run to attempt translation again.
        console.error(`[${identifier}] ❌ Failed to translate or save ${file} after multiple retries: ${error.message}. A partial translation might exist in ${TMP_DIR}.`);
    }
}

async function processSeries(
    seriesInfo: SeriesProcessingInfo,
    pool: PromisePool
): Promise<number> {
    const { identifier, config, inputFolder, outputFolder } = seriesInfo;
    const { glossary, customInstructions, translateChapterMin, translateChapterMax } = config;

    await fs.mkdir(outputFolder, { recursive: true });

    console.log(`\n--- Processing series: ${identifier} ---`);
    console.log(`Input: ${inputFolder}`);
    console.log(`Output: ${outputFolder}`);
    if (glossary) console.log(`Glossary: Loaded for this series.`);
    if (customInstructions) console.log(`Custom Instructions: Loaded for this series.`);

    const inputFiles = await listTextFiles(inputFolder);
    if (inputFiles.length === 0) {
        console.log(`No .txt files found in ${inputFolder}.`);
        return 0;
    }

    let filesAddedToPoolForThisSeries = 0;
    for (const file of inputFiles) {
        const inputPath = path.join(inputFolder, file);
        const outputFileName = file.replace('.txt', '.translated.md');
        const outputPath = path.join(outputFolder, outputFileName);

        // Filter by chapter range
        if (translateChapterMin !== undefined || translateChapterMax !== undefined) {
            const match = file.match(/^(\d{4})\s*-/);
            if (match && match[1]) {
                const chapterNumberFromFile = parseInt(match[1], 10);
                if (!isNaN(chapterNumberFromFile)) {
                    if ((translateChapterMin !== undefined && chapterNumberFromFile < translateChapterMin) ||
                        (translateChapterMax !== undefined && chapterNumberFromFile > translateChapterMax)) {                        
                        continue;
                    }
                }
            } else {
                console.log(`\n[${identifier}] ⏭️ Skipping chapter ${file}. Cannot parse chapter number for range check (min/max).`);
                continue;
            }
        }

        // Filter if already translated
        try {
            await fs.access(outputPath);
            continue;
        } catch (error) {
            // File does not exist, proceed
        }

        filesAddedToPoolForThisSeries++;
        pool.add(() => createTranslationTask(identifier, file, inputPath, outputPath, glossary, customInstructions));
    }

    if (filesAddedToPoolForThisSeries > 0) {
        console.log(`\n[${identifier}] Added ${filesAddedToPoolForThisSeries} chapters to the global translation pool.`);
    } else {
        console.log(`\n[${identifier}] No new chapters to translate in this series.`);
    }
    console.log(`--- Finished scanning series: ${identifier} ---`);
    return filesAddedToPoolForThisSeries;
}

async function main() {
    try {
        await initializeEnvironment();
    } catch (error: any) {
        console.error(`❌ Initialization failed: ${error.message}`);
        process.exit(1);
    }

    const seriesConfigurations = await getOrLoadSeriesConfig();
    const seriesToProcess = await getSeriesToProcess(seriesConfigurations);

    if (seriesToProcess.length === 0) {
        console.log("No series to process. Exiting.");
        return;
    }

    const pool = new PromisePool(TRANSLATION_CONCURRENCY);
    let totalFilesAddedToPool = 0;

    for (const seriesInfo of seriesToProcess) {
        const count = await processSeries(seriesInfo, pool);
        totalFilesAddedToPool += count;
    }

    if (totalFilesAddedToPool > 0) {
        console.log(`\n🌐 All series scanned. A total of ${totalFilesAddedToPool} chapters were added to the global translation pool. Waiting for all translations to complete...`);
        await pool.drain();
        console.log(`\n✅ All ${totalFilesAddedToPool} translations from the pool have completed.`);
    } else {
        console.log(`\n✅ All series scanned. No new chapters were found to translate across any series.`);
    }
}

main().catch(err => {
    console.error("❌ Unhandled error in main execution:", err);
    process.exit(1);
});
