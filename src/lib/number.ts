const chineseNumMap: { [key: string]: number } = {
    '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};
const chineseMultiplierMap: { [key: string]: number } = {
    '十': 10, '百': 100, '千': 1000,
};

/**
 * Converts a Chinese numeral string to an Arabic number.
 * Supports simple cases typically found in chapter titles (up to thousands).
 * e.g., "五" -> 5, "十五" -> 15, "二十" -> 20, "一百二十三" -> 123
 */
function chineseToArabic(str: string): number | null {
    if (!str || !str.trim()) return null;

    let total = 0;
    let currentSegmentValue = 0;
    let currentDigit = 0;
    let foundValidChar = false;

    // Special case for "十" at the beginning, e.g., "十章" -> 10
    if (str.startsWith('十')) {
        if (str.length === 1) return 10;
        const rest = chineseToArabic(str.substring(1));
        return rest !== null ? 10 + rest : 10; // If "十三", rest is 3, so 10+3. If just "十", return 10.
    }

    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (chineseNumMap[char] !== undefined) {
            currentDigit = chineseNumMap[char];
            foundValidChar = true;
        } else if (chineseMultiplierMap[char] !== undefined) {
            const multiplier = chineseMultiplierMap[char];
            if (currentDigit === 0) { // Handle cases like "百" -> 100 (implicit "一")
                 currentDigit = 1;
            }
            currentSegmentValue += currentDigit * multiplier;
            currentDigit = 0;
            foundValidChar = true;
        } else {
            // Invalid character in Chinese numeral string
            return null;
        }
    }
    currentSegmentValue += currentDigit; // Add the last digit if it wasn't followed by a multiplier
    total += currentSegmentValue;

    return foundValidChar ? total : null;
}

/**
 * Extracts chapter number from link text. Handles "第123章", "123", "第一百二十三章".
 * Returns a padded string (e.g., "0123") or null.
 */
export function extractChapterNumber(linkText: string): { numStr: string | null; cleanTitle: string } {
    let cleanTitle = linkText;
    let numStr: string | null = null;

    // Regex for patterns like: "第123章", "Chapter 45", "123. Title", "Vol.1 Ch.2"
    // This regex tries to capture the number and the text surrounding it.
    const arabicPatterns = [
        /^(?:第|\s*CH(?:APTER)?\.?\s*|卷\s*|VOL(?:UME)?\.?\s*)*\s*(\d+)\s*(?:[章章节篇回卷\.:-])?\s*(.*)/i, // Start of string
        /(.*?)(?:第|\s+CH(?:APTER)?\.?\s*|卷\s*|VOL(?:UME)?\.?\s*)\s*(\d+)\s*(?:[章章节篇回卷\.:-])?\s*(.*)/i, // Middle of string
        /(\d+)/, // Fallback: any sequence of digits
    ];

    for (const pattern of arabicPatterns) {
        const match = linkText.match(pattern);
        if (match && match[1] && !isNaN(parseInt(match[1]))) { // Ensure first capture group is a number
            const num = parseInt(match[1], 10);
            numStr = String(num).padStart(4, '0');
            // Try to reconstruct a cleaner title from remaining parts
            if (pattern.source.includes('(.*?)')) { // If it had prefix and suffix capture groups
                 cleanTitle = (match[1].trim() + " " + (match[3] ? match[3].trim() : "")).trim();
            } else if (match[2] && pattern.source.includes('(.*)')) { // If number was at start
                cleanTitle = match[2].trim();
            }
            if (!cleanTitle) cleanTitle = linkText.replace(match[0], '').trim(); // Fallback clean
            break;
        } else if (match && match[2] && !isNaN(parseInt(match[2]))) { // For patterns with prefix
            const num = parseInt(match[2], 10);
            numStr = String(num).padStart(4, '0');
            cleanTitle = (match[1].trim() + " " + (match[3] ? match[3].trim() : "")).trim();
            if (!cleanTitle) cleanTitle = linkText.replace(match[0], '').trim();
            break;
        }
    }


    // If Arabic number not found or not clear, try Chinese numerals
    if (!numStr) {
        const chineseMatch = linkText.match(/^(?:第)?([零〇一二三四五六七八九十百千]+)(?:[章章节篇回卷])?(.*)/);
        if (chineseMatch && chineseMatch[1]) {
            const chinesePart = chineseMatch[1];
            const num = chineseToArabic(chinesePart);
            if (num !== null) {
                numStr = String(num).padStart(4, '0');
                cleanTitle = chineseMatch[2] ? chineseMatch[2].trim() : linkText.replace(chineseMatch[0], '').trim();
            }
        }
    }
    
    if (!cleanTitle || cleanTitle === numStr) cleanTitle = linkText; // Ensure cleanTitle is something meaningful

    return { numStr, cleanTitle: cleanTitle.replace(/[\\/:*?"<>|]/g, '').trim() }; // Sanitize cleanTitle here
}