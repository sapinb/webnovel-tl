import axios from 'axios';
import * as cheerio from 'cheerio';
import * as stringSimilarity from 'string-similarity';
import * as fs from 'fs';
import * as path from 'path';

import {PromisePool} from './lib/promise-pool'
import { extractChapterNumber } from './lib/number';
import { getOrLoadSeriesConfig, RAW_DL_DIR } from './lib/config';
import { SingleSeriesConfig } from './lib/schema';

// --- Configuration ---
// const baseOutputDir = path.join('outputs', 'raw'); // Base directory to save novel folders

// --- CSS Selectors (YOU MIGHT NEED TO UPDATE THESE PER SITE) ---
// These are generic and might need adjustment for different sources if they vary significantly.
// You might consider moving these into the SourceConfig if they change per novel.
const chapterLinkSelector = '.info li a';   // Selector for chapter links on the main page
const chapterTitleSelector = '#neirong h1'; // Selector for the chapter title on a chapter page
const chapterContentSelector = '#txt';      // Selector for the chapter content on a chapter page
// --- End Configuration ---

// Threshold for string similarity (0.0 to 1.0). 0.8 means 80% similar.
const SIMILARITY_THRESHOLD = 0.9;

const extraTextToRemove = [
    "搜书名找不到,可以试试搜作者哦,也许只是改名了!",
    "一秒记住【笔趣阁小说网】biquge345.com，更新快，无弹窗！",
    "本站采用Cookie技术来保存您的「阅读记录」和「书架」,所以清除浏览器Cookie数据丶重装浏览器之类的操作会让您的阅读进度消失哦,建议可以偶尔截图保存书架,以防找不到正在阅读的小说!",
]

interface ChapterInfo {
    pageTitle: string; // The title as it appears on the chapter page
    linkText: string;  // The text from the link on the listing page
    url: string;
    extractedChapterNumber: string | null; // e.g., "0001", "0123"
    filenameSafeTitle: string; // Title part, sanitized, for filename
}




/**
 * Fetches HTML content from a given URL.
 */
async function getHtml(url: string): Promise<string | null> {
    try {
        console.log(`Fetching: ${url}`);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            responseType: 'arraybuffer',
            transformResponse: [data => data],
        });
        return Buffer.from(response.data).toString('utf-8'); // Assuming UTF-8, adjust if site uses GBK (then use iconv-lite)
    } catch (error: unknown) {
        if (axios.isAxiosError(error)) {
            console.error(`Axios error fetching ${url}: ${error.message}`);
        } else if (error instanceof Error) {
            console.error(`Error fetching ${url}: ${error.message}`);
        } else {
            console.error(`An unknown error occurred while fetching ${url}:`, error);
        }
        return null;
    }
}

/**
 * Parses the main page to get all chapter links and their extracted numbers.
 */
function getChapterLinksOnPage(html: string, currentBaseUrl: string): ChapterInfo[] {
    const $ = cheerio.load(html);
    const chapters: ChapterInfo[] = [];

    $(chapterLinkSelector).each((_index, element) => {
        const linkElement = $(element);
        const originalLinkText = linkElement.text().trim();
        let relativeUrl = linkElement.attr('href');

        if (originalLinkText && relativeUrl) {
            const absoluteUrl = new URL(relativeUrl, currentBaseUrl).href;
            const { numStr, cleanTitle } = extractChapterNumber(originalLinkText);

            chapters.push({
                pageTitle: '', // Will be fetched from chapter page
                linkText: originalLinkText,
                url: absoluteUrl,
                extractedChapterNumber: numStr,
                filenameSafeTitle: cleanTitle || originalLinkText.replace(/[\\/:*?"<>|]/g, '').trim(), // Fallback if cleanTitle is empty
            });
        }
    });

    console.log(`Found ${chapters.length} potential chapter links.`);
    return chapters;
}

/**
 * Scrapes a single chapter page for its title and content.
 */
async function scrapeChapterContent(url: string): Promise<{ title: string; content: string } | null> {
    const html = await getHtml(url);
    if (!html) return null;

    const $ = cheerio.load(html);

    const title = $(chapterTitleSelector).text().trim();
    const contentHtml = $(chapterContentSelector)
        .clone()
        .find('a, script, style, div[align="center"], .adsbygoogle') // More elements to remove
        .remove()
        .end()
        .html();

    if (!title || !contentHtml) { // Check if both are missing, sometimes title might be part of linkText
        console.warn(`Could not extract title or content from: ${url}`);
        return null;
    }
    
    let textContent = contentHtml
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/&nbsp;/gi, ' ')
        .replace(/<p>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n') // Add double newline for paragraph breaks
        .replace(/<[^>]+>/g, '');
    
    const lines = textContent.split('\n');
    const filteredLines: string[] = [];
    const trimmedPatternsToRemove = extraTextToRemove.map(p => p.trim()).filter(p => p.length > 0); // Trim patterns and remove empty ones

    for (const line of lines) {
        const trimmedLine = line.trim();

        if (!trimmedLine) { // Keep intentional paragraph breaks if they were made of multiple newlines initially
                            // or discard if it was just whitespace. This matches previous filter(line=>line) behavior.
            continue;
        }

        let isSimilarToPattern = false;
        for (const pattern of trimmedPatternsToRemove) {
            const similarity = stringSimilarity.compareTwoStrings(trimmedLine, pattern);
            if (similarity >= SIMILARITY_THRESHOLD) {
                isSimilarToPattern = true;
                // console.log(`  SIMILARITY REMOVE: Line "${trimmedLine.substring(0, 70)}..." matched pattern "${pattern.substring(0, 70)}..." with similarity ${similarity.toFixed(2)}`);
                break;
            }
        }

        if (!isSimilarToPattern) {
            filteredLines.push(trimmedLine);
        }
    }

    textContent = filteredLines.join('\n').trim(); // Join kept lines and final trim

    return { title: title, content: textContent };
}

/**
 * Saves the chapter content to a text file.
 */
function saveChapterToFile(
    chapter: ChapterInfo,
    chapterContent: { title: string; content: string },
    sourceIdentifier: string,
    chapterIndexForFallback: number
): void {
    const sourceOutputDir = path.join(RAW_DL_DIR, sourceIdentifier);
    if (!fs.existsSync(sourceOutputDir)) {
        fs.mkdirSync(sourceOutputDir, { recursive: true });
    }

    const displayTitle = chapterContent.title || chapter.filenameSafeTitle; // Prefer actual page title
    
    let filename: string;
    if (chapter.extractedChapterNumber) {
        filename = `${chapter.extractedChapterNumber} - ${chapter.filenameSafeTitle || displayTitle}.txt`;
    } else {
        // Fallback if chapter number extraction failed (as per requirement to not use index primarily)
        // Using a padded index as a last resort for ordering if number extraction fails.
        const fallbackNum = String(chapterIndexForFallback).padStart(4, '0');
        filename = `${fallbackNum} - ${chapter.filenameSafeTitle || displayTitle}.txt`;
        console.warn(`  WARN: Could not extract chapter number for "${chapter.linkText}". Using index-based filename: ${filename}`);
    }
    // Further sanitize filename to be sure
    filename = filename.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
    if (filename.length > 200) filename = filename.substring(0, 200) + ".txt"; // Limit filename length


    const filePath = path.join(sourceOutputDir, filename);

    // Feature 1: Skip if file already exists
    if (fs.existsSync(filePath)) {
        console.log(`  SKIPPED (already exists): ${filename}`);
        return;
    }

    try {
        fs.writeFileSync(filePath, `${displayTitle}\n\n${chapterContent.content}`, 'utf-8');
        console.log(`  SAVED: ${filename}`);
    } catch (error: unknown) {
        if (error instanceof Error) {
            console.error(`  Error saving ${filename}: ${error.message}`);
        } else {
            console.error(`  An unknown error occurred while saving ${filename}:`, error);
        }
    }
}

/**
 * Processes a single novel source.
 */
async function processNovelSource(source_identifier: string, source: SingleSeriesConfig, index: number, total: number) {
    console.log(`\n[Processing Source ${index + 1}/${total}: ${source_identifier}]`);
    console.log(`Listing URL: ${source.sourceUrl}`);

    const effectiveBaseUrl = new URL(source.sourceUrl).origin;

    const mainHtml = await getHtml(source.sourceUrl);
    if (!mainHtml) {
        console.error(`Failed to fetch main chapter list for ${source_identifier}. Skipping.`);
        return;
    }

    const chapterInfos = getChapterLinksOnPage(mainHtml, effectiveBaseUrl);

    if (chapterInfos.length === 0) {
        console.warn(`No chapter links found for ${source_identifier} with selector "${chapterLinkSelector}". Check selector or page structure.`);
        return;
    }
    
    const sourceOutputDir = path.join(RAW_DL_DIR, source_identifier);
    if (!fs.existsSync(sourceOutputDir)) {
        fs.mkdirSync(sourceOutputDir, { recursive: true });
    }


    for (let i = 0; i < chapterInfos.length; i++) {
        const chapterInfo = chapterInfos[i];
        console.log(`\nProcessing Chapter ${i + 1}/${chapterInfos.length}: "${chapterInfo.linkText}"`);
        console.log(`  URL: ${chapterInfo.url}`);

        // Construct tentative filename for existence check
        let tentativeFilename: string;
        const tentativeTitle = chapterInfo.filenameSafeTitle || chapterInfo.linkText.replace(/[\\/:*?"<>|]/g, '').trim();
        if (chapterInfo.extractedChapterNumber) {
            tentativeFilename = `${chapterInfo.extractedChapterNumber} - ${tentativeTitle}.txt`;
        } else {
            tentativeFilename = `${String(i + 1).padStart(4, '0')} - ${tentativeTitle}.txt`;
        }
        tentativeFilename = tentativeFilename.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
        if (tentativeFilename.length > 200) tentativeFilename = tentativeFilename.substring(0, 200) + ".txt";


        const tentativeFilePath = path.join(sourceOutputDir, tentativeFilename);
        if (fs.existsSync(tentativeFilePath)) {
            console.log(`  SKIPPED (already exists): ${tentativeFilename}`);
            continue;
        }

        const chapterContent = await scrapeChapterContent(chapterInfo.url);
        if (chapterContent) {
            chapterInfo.pageTitle = chapterContent.title; // Update with actual title from page
            saveChapterToFile(chapterInfo, chapterContent, source_identifier, i + 1);
        } else {
            console.warn(`  Failed to scrape content for: ${chapterInfo.linkText}`);
        }

        // Add a small delay between requests to be polite to the server
        await new Promise(resolve => setTimeout(resolve, 700)); // 0.7 second delay
    }
}

/**
 * Main function to run the scraper for all configured sources.
 */
async function main() {
    if (!fs.existsSync(RAW_DL_DIR)) {
        fs.mkdirSync(RAW_DL_DIR, { recursive: true });
    }

    // Load configurations at the start of main
    const seriesConfigurations = await getOrLoadSeriesConfig();
    const entries = Object.entries(seriesConfigurations).map(([k, v], i) => [i, k, v] as [number, string, SingleSeriesConfig])

    console.log('--- Starting Web Scraper ---');
    let pool = new PromisePool(5)
    let total = entries.length
    for (let [i, k, v] of entries) {
        pool.add(() => processNovelSource(k, v, i, total));
    }

    await pool.drain();

    console.log('\n--- Scraping Finished for All Sources! ---');
}

// Run the main function
main().catch(err => {
    console.error("A critical error occurred in the main process:", err);
});