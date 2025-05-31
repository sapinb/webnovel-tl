# Web Novel Scraper & Translator

This project is a TypeScript-based application designed to scrape web novel chapters from specific sources and then translate them into English using AI translation services.

## Project Overview

The primary goal is to automate the process of:
1.  **Scraping:** Fetching chapter content from web novel websites.
2.  **Translation:** Sending the scraped Chinese text to an AI translation service (currently DeepSeek) to get English translations.

The project is structured to handle multiple novel series, manage configurations for each, and process chapters efficiently.

## Current Status & Features

*   **Scraper:**
    *   Currently, the scraper is specifically configured and tested for **`biquge345.com`**. Support for other sites would require adjusting CSS selectors and potentially other logic within `src/scraper.ts`.
    *   Downloads raw chapter text into organized folders.
    *   Includes basic politeness delays between requests.
    *   Skips already downloaded chapters.
*   **Translator:**
    *   Utilizes the **DeepSeek API** for translation. An API key (`APIKEY_DEEPSEEK`) is required as an environment variable.
    *   Supports custom prompts, glossaries, and retry mechanisms for robust translation.
    *   DeepSeek translations have proven to be significantly better in quality compared to currently available local models for this type of content.
    *   Skips already translated chapters and chapters below a configurable minimum chapter number.

**Note:** A significant portion of the codebase was developed with the assistance of AI coding tools.