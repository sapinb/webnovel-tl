import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';
import readline from 'readline';
import { RAW_DL_DIR, getOrLoadSeriesConfig, TL_DIR, SERIES_CONFIG_FILE } from './lib/config';
import { PromisePool } from './lib/promise-pool';

// DeepSeek API Configuration
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL_NAME = 'deepseek-chat'; // Or any other specific model you want to use, e.g., 'deepseek-coder' for code-related tasks
const API_KEY = process.env.APIKEY_DEEPSEEK;

// Concurrency for translation tasks
const TRANSLATION_CONCURRENCY = parseInt(process.env.TRANSLATION_CONCURRENCY || "3", 10);

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
    glossary?: string, // Glossary is now optional
    customInstructions?: string,
    maxAttempts = 3
): Promise<string> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`\n🈸 Attempt ${attempt} to translate chapter...`);
        try {
            const result = await translateChapter(chineseText, glossary, customInstructions);
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
    glossary?: string, // Glossary is now optional
    customInstructions?: string
): Promise<string> {
    if (!API_KEY) {
        throw new Error("APIKEY_DEEPSEEK environment variable is not set.");
    }

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
                    // process.stdout.write(token); // Removed to prevent interleaved output
                    finalOutput += token;
                } catch (err: any) {
                    // It's possible to receive non-JSON data or metadata in the stream, log and ignore
                    console.warn('\n⚠️ Non-JSON line or parse error in stream:', line, err.message);
                }
            } else {
                 // Log unexpected lines that are not part of SSE format
                 console.warn('\n⚠️ Unexpected line in stream:', line);
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
            console.error(`\n❌ Error during translation: ${err.message}`);
            throw err; // Re-throw other errors
        }
    } finally {
        clearTimeout(timeout);
    }

    if (finalOutput.trim() === '') {
        console.warn("\n⚠️ Translation result is empty.");
        // Optionally throw an error here if an empty translation is considered a failure
        // throw new Error("Translation result is empty.");
    }
    
    return finalOutput;
}

async function main() {
    if (!API_KEY) {
        console.error("❌ APIKEY_DEEPSEEK environment variable is not set. Please set it before running the script.");
        process.exit(1);
    }
    console.log("✅ DeepSeek API Key found.");

    await fs.mkdir(TL_DIR, { recursive: true });

    const seriesConfigurations = await getOrLoadSeriesConfig();
    const seriesIdentifiers = await fs.readdir(RAW_DL_DIR, { withFileTypes: true })
        .then(dirents => dirents.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name))
        .catch(err => {
            console.error(`❌ Could not read series identifiers from ${RAW_DL_DIR}: ${err.message}`);
            return [];
        });

    if (seriesIdentifiers.length === 0) {
        console.log(`No series found in ${RAW_DL_DIR}. Exiting.`);
        return;
    }

    const pool = new PromisePool(TRANSLATION_CONCURRENCY);
    let totalFilesAddedToPool = 0;

    for (const identifier of seriesIdentifiers) {
        if (!seriesConfigurations[identifier]) {
            console.warn(`\n⏭️ Skipping series '${identifier}': No configuration found in '${SERIES_CONFIG_FILE}'.`);
            continue;
        }

        if (seriesConfigurations[identifier].skipTranslation) {
            console.warn(`\n⏭️ Skipping series '${identifier}': Marked as skipTranslation in config.`);
            continue;
        }

        const inputSeriesFolder = path.join(RAW_DL_DIR, identifier);
        const outputSeriesFolder = path.join(TL_DIR, identifier);
        const seriesConfig = seriesConfigurations[identifier];
        const { glossary, customInstructions, translateChapterMin, translateChapterMax } = seriesConfig;

        await fs.mkdir(outputSeriesFolder, { recursive: true });

        console.log(`\n--- Processing series: ${identifier} ---`);
        console.log(`Input: ${inputSeriesFolder}`);
        console.log(`Output: ${outputSeriesFolder}`);
        if(glossary) console.log(`Glossary: Loaded for this series.`);
        if(customInstructions) console.log(`Custom Instructions: Loaded for this series.`);


        const inputFiles = await listTextFiles(inputSeriesFolder);
        if (inputFiles.length === 0) {
            console.log(`No .txt files found in ${inputSeriesFolder}.`);
            continue;
        }

        let filesAddedToPoolForThisSeries = 0;

        for (const file of inputFiles) {
            const inputPath = path.join(inputSeriesFolder, file);
            const outputFileName = file.replace('.txt', '.translated.txt');
            const outputPath = path.join(outputSeriesFolder, outputFileName);

            // Check for translateChapterMin and translateChapterMax
            if (translateChapterMin !== undefined || translateChapterMax !== undefined) {
                // Try to extract chapter number from filename, e.g., "0001 - Title.txt"
                const match = file.match(/^(\d{4})\s*-/); // Matches "NNNN - "
                if (match && match[1]) {
                    const chapterNumberFromFile = parseInt(match[1], 10);
                    if (!isNaN(chapterNumberFromFile)) {
                        if (translateChapterMin !== undefined && chapterNumberFromFile < translateChapterMin) {
                            // console.log(`\n[${identifier}] ⏭️ Skipping chapter ${file} (Ch. ${chapterNumberFromFile}). Below min ${translateChapterMin}.`);
                            continue; // Skip this file
                        }
                        if (translateChapterMax !== undefined && chapterNumberFromFile > translateChapterMax) {
                            // console.log(`\n[${identifier}] ⏭️ Skipping chapter ${file} (Ch. ${chapterNumberFromFile}). Above max ${translateChapterMax}.`);
                            continue; // Skip this file
                        }
                    }
                } else {
                    console.log(`\n[${identifier}] ⏭️ Skipping chapter ${file}. Cannot parse chapter number for range check (min/max).`);
                    continue; 
                }
            }

            try {
                await fs.access(outputPath);
                // console.log(`[${identifier}] ✅ Skipping already translated: ${file} (output file exists)`);
                continue;
            } catch (error) {
                // File does not exist, proceed with translation
            }

            filesAddedToPoolForThisSeries++;
            totalFilesAddedToPool++;
            pool.add(async () => {
                console.log(`[${identifier}] 📖 Reading: ${file}`);
                const chineseText = await readFileContent(inputPath);

                if (!chineseText.trim()) {
                    console.warn(`[${identifier}] ⚠️ Skipping empty file: ${file}. Creating empty placeholder.`);
                    await writeToFile(outputPath, ""); 
                    return;
                }

                console.log(`[${identifier}] 🌐 Translating: ${file} using DeepSeek API...`);
                try {
                    const fullResponse = await translateChapterWithRetry(chineseText, glossary, customInstructions);
                    const trimmed = extractTranslation(fullResponse);

                    if (trimmed) {
                        // console.log(`[${identifier}] 📤 Translation for ${file} finished. Saving output.`);
                        await writeToFile(outputPath, trimmed);
                        console.log(`[${identifier}] 💾 Saved: ${outputPath}`);
                    } else {
                        console.warn(`[${identifier}] ⚠️ Translation for ${file} resulted in empty output after trimming. Saving placeholder.`);
                        await writeToFile(outputPath, ""); // Save empty file as placeholder
                        console.log(`[${identifier}] 💾 Saved placeholder (empty translation): ${outputPath}`);
                    }

                } catch (error: any) {
                    console.error(`[${identifier}] ❌ Failed to translate ${file} after multiple retries: ${error.message}`);
                    try {
                        await writeToFile(outputPath, `Error: Translation failed for ${file}. ${error.message}`);
                        console.log(`[${identifier}] 💾 Saved error placeholder: ${outputPath}`);
                    } catch (writeError: any) {
                        console.error(`[${identifier}] ❌ Could not write error placeholder for ${outputPath} after error: ${writeError.message}`);
                    }
                }
            });
        }
        if (filesAddedToPoolForThisSeries > 0) {
            console.log(`\n[${identifier}] Added ${filesAddedToPoolForThisSeries} chapters to the global translation pool.`);
        } else {
            console.log(`\n[${identifier}] No new chapters to translate in this series.`);
        }
        console.log(`--- Finished processing series: ${identifier} ---`);
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
    console.error("❌ Unhandled error in main:", err);
    process.exit(1);
});