import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';
import readline from 'readline';
import { RAW_DL_DIR, BASE_URL, getOrLoadSeriesConfig, MODEL_NAME, TL_DIR, SERIES_CONFIG_FILE } from './lib/config';


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
    return content;
}

export async function translateChapterWithRetry(
    chineseText: string,
    glossary?: string,
    customInstructions?: string,
    maxAttempts = 3
): Promise<string> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`\n🈸 Attempt ${attempt} to translate chapter...`);
        try {
            const result = await translateChapter(chineseText, glossary, customInstructions);
            console.log('✅ Chapter translated successfully.');
            return result;
        } catch (err) {
            console.warn(`⚠️ Attempt ${attempt} failed. Retrying...`);
            await new Promise(res => setTimeout(res, 3000));
        }
    }

    throw new Error('❌ All retries failed due to repetition or timeout.');
}

async function translateChapter(
    chineseText: string,
    glossary?: string,
    customInstructions?: string
): Promise<string> {
//     const prompt = `
// You are a professional literary translator. Translate the following Chinese web novel chapter into natural, fluent English prose.

// - Preserve the **original tone, mood, and writing style** — including humor, intensity, and dramatic pacing.
// - Preserve all **cultural nuances** and avoid flattening culturally specific ideas or idioms.
// - Use the **provided glossary** to handle names and locations. **Never translate proper names** — render them using **standardized Pinyin** from the glossary.
// - Do **not literally translate names**. For example, NEVER translate "龙傲天" as "Dragon Aotian" — always use "Long Aotian".
// - Ignore any lines that are **unrelated to the story** (e.g., site footers, cookie notices, login info).

// ${customInstructions ? customInstructions : ''}

// ${glossary}

// --- START OF CHAPTER ---
// ${chineseText}
// --- END OF CHAPTER ---
// `;

    const prompt = `
Role & Objective:
You are a professional literary translator specializing in Chinese-to-English web novels. Your task is to produce a natural, emotionally resonant English translation that:
* Preserves the original's tone (e.g., melancholic, romantic, dramatic)
* Conveys cultural nuances without awkward literalness
* Maintains character voices and stylistic quirks
* Flows like native English prose

Key Guidelines:
* Dialogue: Keep conversations dynamic. Use contractions ("don’t," "can’t") and informal phrasing where appropriate.
* Inner Monologues: Use italicization for emphasis and stream-of-consciousness pacing.
* Descriptions: Prioritize vividness over literal accuracy (e.g., "心绪复杂" → "his mind weighed down with unspoken thoughts").
* Cultural Terms: Localize idioms (e.g., "刀子不落在自己身上" → "When the knife doesn’t cut your own flesh").
* Pacing: Short sentences for tension, longer ones for introspection.

Output Format:

* Bold chapter titles with consistent numbering
* Line breaks between paragraphs for readability
* Italics for character thoughts or emphasis
* "..." for trailing emotions, "—" for interrupted speech

Example Input (Chinese):

第463章 我只是好像有点喜欢你了
沉默良久，龙傲天轻叹一声：“我并不认为自己是一个好人..."

Example Output (English):

Chapter 463: I Just Seem to Have Grown to Like You
After a long silence, Long Aotian sighed softly. I don’t consider myself a good person...

Task:
Translate the following Chinese web novel chapter while adhering to the above standards. Capture the emotional subtext and character dynamics faithfully:

${chineseText}
    `

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000); // 5 minute timeout

    let finalOutput = '';

    try {
        const response = await axios.post(`${BASE_URL}/api/chat`, {
            model: MODEL_NAME,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            keep_alive: "0s",
            top_k: 64,
            top_p: 0.95,
            repeat_penalty: 1.2,
            stream: true
        }, {
            responseType: 'stream',
            signal: controller.signal,
        });

        const stream = response.data as Readable;
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        for await (const line of rl) {
            if (!line.trim()) continue;

            if (line.trim() === '[DONE]') break;

            let token = '';

            try {
                const data = JSON.parse(line);
                token = data.message?.content || data.delta?.content || '';
            } catch (err) {
                console.error('⚠️ JSON parse error:', err);
            }

            process.stdout.write(token);
            finalOutput += token;
        }

    } catch (err: any) {
        if (err.name === 'AbortError') {
            console.error('\n❌ Translation timed out.');
        } else {
            console.error(`\n❌ Error during translation: ${err.message}`);
        }
    } finally {
        clearTimeout(timeout);
    }

    return finalOutput;
}

async function main() {
    await fs.mkdir(TL_DIR, { recursive: true });

    // Load configurations at the start of main
    const seriesConfigurations = await getOrLoadSeriesConfig();

    // Get all directories (identifiers) within the base series folder
    const seriesIdentifiers = await fs.readdir(RAW_DL_DIR, { withFileTypes: true })
        .then(dirents => dirents.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name));

    for (const identifier of seriesIdentifiers) {
        // Skip identifiers not configured
        if (!seriesConfigurations[identifier]) {
            console.warn(`\nSkipping series '${identifier}': No configuration found in '${SERIES_CONFIG_FILE}'.`);
            continue;
        }

        if (seriesConfigurations[identifier].skipTranslation) {
            console.warn(`\nSkipping series '${identifier}': marked as skipTranslation.`);
            continue;
        }

        const inputSeriesFolder = path.join(RAW_DL_DIR, identifier);
        const outputSeriesFolder = path.join(TL_DIR, identifier);
        const { glossary, customInstructions } = seriesConfigurations[identifier];

        await fs.mkdir(outputSeriesFolder, { recursive: true });

        console.log(`\n--- Processing series: ${identifier} ---`);
        console.log(`Input: ${inputSeriesFolder}`);
        console.log(`Output: ${outputSeriesFolder}`);

        const inputFiles = await listTextFiles(inputSeriesFolder);

        for (const file of inputFiles) {
            const inputPath = path.join(inputSeriesFolder, file);
            const outputFileName = file.replace('.txt', '.translated.txt');
            const outputPath = path.join(outputSeriesFolder, outputFileName);

            // Check for duplication by checking if the output file already exists
            try {
                await fs.access(outputPath);
                console.log(`✅ Skipping already translated: ${file} in ${identifier} (output file exists)`);
                continue;
            } catch (error) {
                // File does not exist, proceed with translation
            }

            console.log(`\n📖 Reading: ${file} from ${identifier}`);
            const chineseText = await readFileContent(inputPath);

            console.log(`🌐 Translating: ${file} for series ${identifier}`);
            const fullResponse = await translateChapterWithRetry(chineseText, glossary, customInstructions);

            console.log(`\n\n📤 Done. Saving output.`);
            const trimmed = extractTranslation(fullResponse);
            await writeToFile(outputPath, trimmed);

            console.log(`💾 Saved to ${outputPath}`);
            // console.log('⏳ Waiting 5 seconds before next file...\n');

            // await new Promise(res => setTimeout(res, 5000));
        }
        console.log(`--- Finished processing series: ${identifier} ---`);
    }

    console.log(`✅ All series processed.`);
}

main().catch(console.error);