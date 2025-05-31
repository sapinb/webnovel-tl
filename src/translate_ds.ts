import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';
import readline from 'readline';
import { RAW_DL_DIR, getOrLoadSeriesConfig, TL_DIR, SERIES_CONFIG_FILE } from './lib/config'; // Assuming these are still needed

// DeepSeek API Configuration
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL_NAME = 'deepseek-chat'; // Or any other specific model you want to use, e.g., 'deepseek-coder' for code-related tasks
const API_KEY = process.env.APIKEY_DEEPSEEK;

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
            max_tokens: 4000, // Adjust as needed, ensures output isn't excessively long / controls cost
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
                    process.stdout.write(token);
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
        // Glossary and customInstructions can be undefined if not present in config
        const { glossary, customInstructions } = seriesConfigurations[identifier];

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

        for (const file of inputFiles) {
            const inputPath = path.join(inputSeriesFolder, file);
            const outputFileName = file.replace('.txt', '.translated.txt');
            const outputPath = path.join(outputSeriesFolder, outputFileName);

            try {
                await fs.access(outputPath);
                console.log(`✅ Skipping already translated: ${file} in ${identifier} (output file exists)`);
                continue;
            } catch (error) {
                // File does not exist, proceed with translation
            }

            console.log(`\n📖 Reading: ${file} from ${identifier}`);
            const chineseText = await readFileContent(inputPath);

            if (!chineseText.trim()) {
                console.warn(`⚠️ Skipping empty file: ${file}`);
                // await writeToFile(outputPath, ""); // Create an empty placeholder
                continue;
            }

            console.log(`🌐 Translating: ${file} for series ${identifier} using DeepSeek API...`);
            try {
                const fullResponse = await translateChapterWithRetry(chineseText, glossary, customInstructions);
                const trimmed = extractTranslation(fullResponse);

                if (trimmed) {
                    console.log(`\n\n📤 Translation finished. Saving output.`);
                    await writeToFile(outputPath, trimmed);
                    console.log(`💾 Saved to ${outputPath}`);
                } else {
                    console.warn(`\n\n⚠️ Translation for ${file} resulted in empty output after trimming. Saving placeholder.`);
                    await writeToFile(outputPath, "");
                }

            } catch (error: any) {
                console.error(`\n❌ Failed to translate ${file} for series ${identifier} after multiple retries: ${error.message}`);
                // Optionally, write an error marker to the output file
                try {
                    await writeToFile(outputPath, ``);
                } catch (writeError: any) {
                    console.error(`❌ Could not even write error placeholder for ${outputPath}: ${writeError.message}`);
                }
            }
            // console.log('⏳ Waiting 5 seconds before next file...\n');
            // await new Promise(res => setTimeout(res, 5000)); // Consider if this delay is still needed
        }
        console.log(`--- Finished processing series: ${identifier} ---`);
    }

    console.log(`\n✅ All series processed.`);
}

main().catch(err => {
    console.error("❌ Unhandled error in main:", err);
    process.exit(1);
});