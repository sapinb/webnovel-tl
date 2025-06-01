import axios from 'axios';
import * as cheerio from 'cheerio';
import * as stringSimilarity from 'string-similarity';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';

import {PromisePool} from './lib/promise-pool'
import { extractChapterNumber } from './lib/number';
import { getOrLoadSeriesConfig, RAW_DL_DIR } from './lib/config';
import { SingleSeriesConfig } from './lib/schema';

// Threshold for string similarity (0.0 to 1.0). 0.8 means 80% similar.
const SIMILARITY_THRESHOLD = 0.9;

// --- Site-Specific Scraping Configuration ---
interface SiteScrapingConfig {
    chapterLinkSelector: string;
    chapterTitleSelector: string;
    chapterContentSelector: string;
    extraTextToRemove: string[];
    encoding?: string; // Optional: e.g., 'gbk', 'utf-8' (defaults to utf-8 if not provided)
}

// Each entry MUST be a complete SiteScrapingConfig.
// There is no default fallback anymore.
const siteSpecificScrapingConfigs: Record<string, SiteScrapingConfig> = {
    "www.biquge345.com": { // Hostname as key
        chapterLinkSelector: '.info li a',
        chapterTitleSelector: '#neirong h1',
        chapterContentSelector: '#txt',
        extraTextToRemove: [
            "搜书名找不到,可以试试搜作者哦,也许只是改名了!",
            "一秒记住【笔趣阁小说网】biquge345.com，更新快，无弹窗！",
            "本站采用Cookie技术来保存您的「阅读记录」和「书架」,所以清除浏览器Cookie数据丶重装浏览器之类的操作会让您的阅读进度消失哦,建议可以偶尔截图保存书架,以防找不到正在阅读的小说!",
            // Add any other biquge345 specific removal patterns here
        ]
    },
    "www.biquge900.com": {
        chapterLinkSelector: '#list a',
        chapterTitleSelector: '.bookname h1',
        chapterContentSelector: '#content',
        encoding: 'gbk',
        extraTextToRemove: [
            "Please support our sponsors!",
            "Read more at Another Example Site dot com",
            // Add any other specific removal patterns for this site
        ]
    }
    // Add more site-specific configurations here
    // e.g., "m.another-site.com": { ... }
};

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
async function getHtml(url: string, siteEncoding?: string): Promise<string | null> {
    try {
        console.log(`Fetching: ${url}`);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7' // More comprehensive Accept header
            },
            responseType: 'arraybuffer', // Crucial for getting raw bytes
            // transformResponse: [data => data], // This is default behavior for arraybuffer and is fine
        });

        // response.data will be an ArrayBuffer here
        const buffer = Buffer.from(response.data); // Convert ArrayBuffer to Node.js Buffer

        const encodingToUse = (siteEncoding || 'utf-8').toLowerCase();

        if (encodingToUse !== 'utf-8' && iconv.encodingExists(encodingToUse)) {
            console.log(`Decoding with: ${encodingToUse}`);
            return iconv.decode(buffer, encodingToUse);
        } else {
            if (encodingToUse !== 'utf-8' && !iconv.encodingExists(encodingToUse)) {
                console.warn(`Encoding '${encodingToUse}' not supported by iconv-lite. Falling back to UTF-8 decoding for ${url}.`);
            }
            return buffer.toString('utf-8'); // Default to UTF-8
        }
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
function getChapterLinksOnPage(html: string, currentBaseUrl: string, chapterLinkSelector: string): ChapterInfo[] {
    const $ = cheerio.load(html);
    const chapters: ChapterInfo[] = [];

    $(chapterLinkSelector).each((_index, element) => { // Use the passed selector
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
                extractedChapterNumber: numStr, // numStr is like "0001" or null
                filenameSafeTitle: cleanTitle, // cleanTitle is the sanitized title part, or sanitized originalLinkText if numStr is null
            });
        }
    });

    console.log(`Found ${chapters.length} potential chapter links.`);
    return chapters;
}

/**
 * Scrapes a single chapter page for its title and content.
 */
async function scrapeChapterContent(
    url: string,
    config: Pick<SiteScrapingConfig, 'chapterTitleSelector' | 'chapterContentSelector' | 'extraTextToRemove'>,
    siteEncoding?: string
): Promise<{ title: string; content: string } | null> {
    const html = await getHtml(url, siteEncoding);
    if (!html) return null;

    const $ = cheerio.load(html);

    const { chapterTitleSelector, chapterContentSelector, extraTextToRemove: siteExtraTextToRemove } = config;

    const title = $(chapterTitleSelector).text().trim(); // Use passed selector
    const contentHtml = $(chapterContentSelector) // Use passed selector
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
    const trimmedPatternsToRemove = siteExtraTextToRemove.map(p => p.trim()).filter(p => p.length > 0); // Use passed extraTextToRemove

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
 * Generates a sanitized filename for a chapter.
 * - If chapter number exists: "NNNN - Title Part.txt"
 * - If no chapter number: "Full Link Text (Sanitized).txt"
 * - Handles empty/invalid names with a fallback: "chapter-INDEX.txt" or "unknown-INDEX.txt"
 */
function generateChapterFilename(
    chapterLinkText: string, // Original link text, for fallback name generation
    extractedChapterNumber: string | null,
    filenameSafeTitleFromInfo: string, // This is chapter.filenameSafeTitle (already sanitized by extractChapterNumber)
    chapterIndexForFallback: number // Used if filenameSafeTitleFromInfo leads to an empty base name
): string {
    let baseFilenameCandidate: string;

    if (extractedChapterNumber) {
        // filenameSafeTitleFromInfo is the clean title part, already sanitized by extractChapterNumber
        baseFilenameCandidate = `${extractedChapterNumber} - ${filenameSafeTitleFromInfo}`;
    } else {
        // filenameSafeTitleFromInfo is the sanitized full original text (or best effort title from extractChapterNumber)
        baseFilenameCandidate = filenameSafeTitleFromInfo;
    }

    // Trim whitespace that might result from concatenation or if filenameSafeTitleFromInfo was empty/all-space.
    // filenameSafeTitleFromInfo is already sanitized for invalid characters by extractChapterNumber.
    let sanitizedBaseFilename = baseFilenameCandidate.trim();

    const MAX_BASE_FILENAME_LENGTH = 200; // Max length for the base name part (before .txt)
    if (sanitizedBaseFilename.length > MAX_BASE_FILENAME_LENGTH) {
        sanitizedBaseFilename = sanitizedBaseFilename.substring(0, MAX_BASE_FILENAME_LENGTH);
    }
    
    // If, after assembly, trimming, and truncation, the filename is empty
    if (!sanitizedBaseFilename) {
        let fallbackBase = chapterLinkText.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
        if (!fallbackBase) { // If sanitized original linkText is also empty
            fallbackBase = `chapter-${String(chapterIndexForFallback).padStart(4, '0')}`;
        }
        sanitizedBaseFilename = fallbackBase.substring(0, MAX_BASE_FILENAME_LENGTH).trim(); // Ensure fallback also respects length and is trimmed
        // Absolute last resort if even the fallback becomes empty (e.g. chapterLinkText was all invalid chars and fallbackBase was just `chapter-XXXX` but got mangled)
        if (!sanitizedBaseFilename) sanitizedBaseFilename = `unknown-${String(chapterIndexForFallback).padStart(4, '0')}`; 
    }
    return `${sanitizedBaseFilename}.txt`;
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

    const filename = generateChapterFilename(
        chapter.linkText,
        chapter.extractedChapterNumber,
        chapter.filenameSafeTitle,
        chapterIndexForFallback
    );

    if (!chapter.extractedChapterNumber) {
        const baseNameFromFilename = filename.slice(0, -4); // remove .txt
        const fallbackPrefix = `chapter-${String(chapterIndexForFallback).padStart(4, '0')}`;
        const unknownFallbackPrefix = `unknown-${String(chapterIndexForFallback).padStart(4, '0')}`;
        if (baseNameFromFilename === fallbackPrefix || baseNameFromFilename === unknownFallbackPrefix) {
             console.warn(`  WARN: Could not extract chapter number for "${chapter.linkText}" AND its text was invalid/empty. Using fallback filename: ${filename}`);
        } else {
             console.warn(`  WARN: Could not extract chapter number for "${chapter.linkText}". Using text-based filename: ${filename}`);
        }
    }

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

    const sourceUrlObj = new URL(source.sourceUrl);
    const effectiveBaseUrl = sourceUrlObj.origin;
    const hostname = sourceUrlObj.hostname;

    // Get the scraping configuration for this site
    const currentScrapingConfig = siteSpecificScrapingConfigs[hostname];

    if (!currentScrapingConfig) {
        console.warn(`⚠️ No scraping configuration found for hostname: '${hostname}' (source: ${source_identifier}). Skipping this source.`);
        return;
    }
    console.log(`Using specific config for hostname: ${hostname}`);

    const mainHtml = await getHtml(source.sourceUrl, currentScrapingConfig?.encoding);
    if (!mainHtml) {
        console.error(`Failed to fetch main chapter list for ${source_identifier}. Skipping.`);
        return;
    }

    const chapterInfos = getChapterLinksOnPage(mainHtml, effectiveBaseUrl, currentScrapingConfig.chapterLinkSelector);

    if (chapterInfos.length === 0) {
        console.warn(`No chapter links found for ${source_identifier} with selector "${currentScrapingConfig.chapterLinkSelector}". Check selector or page structure.`);
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

        // Construct tentative filename for existence check, must match saveChapterToFile logic
        const tentativeFilename = generateChapterFilename(
            chapterInfo.linkText,
            chapterInfo.extractedChapterNumber,
            chapterInfo.filenameSafeTitle,
            i + 1 // chapterIndexForFallback
        );
        
        const tentativeFilePath = path.join(sourceOutputDir, tentativeFilename);
        if (fs.existsSync(tentativeFilePath)) {
            console.log(`  SKIPPED (already exists): ${tentativeFilename}`);
            continue;
        }

        const chapterContent = await scrapeChapterContent(chapterInfo.url, {
            chapterTitleSelector: currentScrapingConfig.chapterTitleSelector,
            chapterContentSelector: currentScrapingConfig.chapterContentSelector,
            extraTextToRemove: currentScrapingConfig.extraTextToRemove,
        }, currentScrapingConfig.encoding); // Pass encoding here
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